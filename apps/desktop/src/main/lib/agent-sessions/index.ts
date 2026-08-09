/**
 * Boot wiring for agent session tracking (Mission Control Feature 2).
 *
 * The ingest path is deliberately singular: every state change — whether it
 * came from a Claude Code hook POSTing /hook/complete, or from `ade agent-event`
 * over the control socket — lands in `ingestAgentEvent` here. There is exactly
 * one writer of AgentSession state, and the existing hook pipeline stays the
 * only writer of PaneStatus (the renderer's useAgentHookListener), so this
 * feature adds no second path to the same UI affordance.
 */

import { appState } from "../app-state";
import { getControlPlaneEvents } from "../control-plane";
import { loadAgentSessions, saveAgentSession } from "./persistence";
import {
	type AgentEventInput,
	type AgentSessionRecord,
	AgentSessionRegistry,
	type AgentSessionTransition,
} from "./registry";
import {
	inspectTranscript,
	STALE_AFTER_MS,
	SWEEP_INTERVAL_MS,
} from "./transcript-corrector";

export type {
	AgentSessionRecord,
	AgentSessionState,
	AgentSessionTransition,
} from "./registry";
export { AgentSessionRegistry } from "./registry";

const registry = new AgentSessionRegistry();
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;

export function getAgentSessionRegistry(): AgentSessionRegistry {
	return registry;
}

export function listAgentSessions(): AgentSessionRecord[] {
	return registry.list();
}

function publish(transition: AgentSessionTransition | null): void {
	if (!transition) return;
	const record = registry.get(transition.surfaceId);
	if (record) saveAgentSession(record);

	// The bus is null until the control socket has started, and stays null if it
	// failed to bind. Session tracking must work either way.
	getControlPlaneEvents()?.emit("agent-state-changed", {
		surfaceId: transition.surfaceId,
		workspaceId: transition.workspaceId,
		from: transition.from,
		to: transition.to,
	});
}

/** The one ingest point. Returns the transition, or null if nothing changed. */
export function ingestAgentEvent(
	input: AgentEventInput,
): AgentSessionTransition | null {
	const transition = registry.applyEvent(input);
	publish(transition);
	return transition;
}

/** The pane's PTY exited — terminal-host owns the child, so this is authoritative. */
export function markAgentSessionEnded(surfaceId: string): void {
	publish(registry.markEnded(surfaceId));
}

/**
 * Restores snapshots and ends any session whose pane is gone from the layout.
 * Reads the same tabs mirror the control plane reads; if it is not populated
 * yet, reconciliation is skipped rather than ending every session on a slow
 * boot — a stale `working` is corrected by the sweep, a wrongly-ended session
 * is not recoverable.
 */
export function reconcileAgentSessionsOnBoot(): void {
	const loaded = loadAgentSessions();
	if (loaded.length === 0) return;
	registry.load(loaded);

	const panes = appState.data?.tabsState?.panes;
	if (!panes) {
		console.log(
			"[agent-sessions] Tabs mirror not ready; skipping boot reconciliation",
		);
		return;
	}

	const transitions = registry.reconcile(new Set(Object.keys(panes)));
	for (const transition of transitions) {
		console.log(
			`[agent-sessions] reconcile ${transition.surfaceId}: ${transition.from} -> ended (pane no longer exists)`,
		);
		publish(transition);
	}
}

/**
 * Sweeps for sessions stuck in `working`. The transcript read is awaited off
 * the timer callback's critical path and guarded by `sweepInFlight`, so a slow
 * disk cannot stack sweeps on top of each other.
 */
async function sweepStuckSessions(): Promise<void> {
	if (sweepInFlight) return;
	sweepInFlight = true;
	try {
		for (const record of registry.stuckCandidates(STALE_AFTER_MS)) {
			if (!record.transcriptPath) continue;
			const verdict = await inspectTranscript(record.transcriptPath);
			if (verdict === "working") continue;

			const transition = registry.correctStuck(record.surfaceId, verdict);
			if (!transition) continue;
			console.log(
				`[agent-sessions] transcript correction ${transition.surfaceId}: ` +
					`${transition.from} -> ${transition.to} ` +
					`(no hook for ${Math.round((transition.at - record.lastActivityAt) / 1000)}s, ` +
					`transcript ${record.transcriptPath})`,
			);
			publish(transition);
		}
	} catch (error) {
		console.error("[agent-sessions] Stuck-state sweep failed:", error);
	} finally {
		sweepInFlight = false;
	}
}

export function startAgentSessionTracking(): void {
	reconcileAgentSessionsOnBoot();
	if (sweepTimer) return;
	sweepTimer = setInterval(() => {
		void sweepStuckSessions();
	}, SWEEP_INTERVAL_MS);
	sweepTimer.unref?.();
}

export function stopAgentSessionTracking(): void {
	if (!sweepTimer) return;
	clearInterval(sweepTimer);
	sweepTimer = null;
}

/** Exposed for tests; the scheduled path goes through the timer. */
export { sweepStuckSessions };
