/**
 * The AgentSession registry — Mission Control Feature 2's authoritative record
 * of what the agent in each terminal pane is doing.
 *
 * Design rule from the spec, and the reason this class is deliberately dull:
 * **hooks are the authority**. Every state here comes from a hook event ADE
 * registered, or from a pane's PTY actually exiting. Nothing infers state from
 * screen text or a window title, and the transcript corrector may only move a
 * session OUT of a stuck `working` — never invent a session that no hook
 * announced.
 *
 * This module is Electron-free and side-effect-free so the transition table can
 * be unit-tested directly. Persistence, timers and event fan-out are wired in
 * index.ts.
 */
import type { AgentSessionState } from "../notifications/map-event-type";

export type { AgentSessionState };

export interface AgentSessionRecord {
	/** Pane id — `ADE_SURFACE_ID`. One agent per pane. */
	surfaceId: string;
	workspaceId: string | null;
	agentKind: string;
	/** The agent CLI's own session id, when it reports one. */
	sessionId: string | null;
	/** Conversation JSONL, when the hook reported one. */
	transcriptPath: string | null;
	state: AgentSessionState;
	pid: number | null;
	/** Epoch ms of the last hook event or liveness signal. */
	lastActivityAt: number;
}

export interface AgentSessionTransition {
	surfaceId: string;
	workspaceId: string | null;
	from: AgentSessionState;
	to: AgentSessionState;
	/** What moved it: a hook, the PTY exiting, boot reconciliation, correction. */
	cause: "hook" | "pty-exit" | "reconcile" | "transcript-correction";
	at: number;
}

export interface AgentEventInput {
	surfaceId: string;
	state: AgentSessionState;
	workspaceId?: string | null;
	agentKind?: string;
	sessionId?: string | null;
	transcriptPath?: string | null;
	pid?: number | null;
	at?: number;
}

/**
 * A session that has ENDED stays ended until a new hook event arrives for that
 * pane. It is not deleted: the pane may still exist, and `agent-sessions`
 * showing a finished agent is more useful than showing nothing.
 */
export class AgentSessionRegistry {
	private records = new Map<string, AgentSessionRecord>();
	private listeners = new Set<(t: AgentSessionTransition) => void>();

	onTransition(fn: (t: AgentSessionTransition) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	list(): AgentSessionRecord[] {
		return [...this.records.values()].sort(
			(a, b) => b.lastActivityAt - a.lastActivityAt,
		);
	}

	get(surfaceId: string): AgentSessionRecord | undefined {
		return this.records.get(surfaceId);
	}

	/** Rehydrates persisted rows on boot WITHOUT emitting transitions. */
	load(records: AgentSessionRecord[]): void {
		for (const record of records) {
			this.records.set(record.surfaceId, { ...record });
		}
	}

	/**
	 * Applies a hook event. Returns the transition when the state actually
	 * changed, null when it did not — callers use that to avoid emitting a
	 * bus event per PostToolUse in a long tool loop.
	 */
	applyEvent(input: AgentEventInput): AgentSessionTransition | null {
		const at = input.at ?? Date.now();
		const existing = this.records.get(input.surfaceId);
		const from = existing?.state ?? "idle";

		const record: AgentSessionRecord = {
			surfaceId: input.surfaceId,
			// A field the event does not carry keeps its previous value: hooks
			// report ids inconsistently (SessionStart has no transcript yet), and
			// overwriting with undefined would erase what an earlier hook told us.
			workspaceId: input.workspaceId ?? existing?.workspaceId ?? null,
			agentKind: input.agentKind ?? existing?.agentKind ?? "claude",
			sessionId: input.sessionId ?? existing?.sessionId ?? null,
			transcriptPath: input.transcriptPath ?? existing?.transcriptPath ?? null,
			state: input.state,
			pid: input.pid ?? existing?.pid ?? null,
			lastActivityAt: at,
		};
		this.records.set(input.surfaceId, record);

		// lastActivityAt moved even when the state did not — that is what keeps a
		// busy tool loop from tripping the stuck-state corrector.
		if (existing && from === input.state) return null;

		return this.emit({
			surfaceId: input.surfaceId,
			workspaceId: record.workspaceId,
			from,
			to: input.state,
			cause: "hook",
			at,
		});
	}

	/**
	 * The pane's PTY exited. Liveness comes from terminal-host owning the child
	 * process, so there is no pid polling anywhere in this feature.
	 */
	markEnded(
		surfaceId: string,
		cause: AgentSessionTransition["cause"] = "pty-exit",
		at = Date.now(),
	): AgentSessionTransition | null {
		const existing = this.records.get(surfaceId);
		if (!existing || existing.state === "ended") return null;
		this.records.set(surfaceId, {
			...existing,
			state: "ended",
			lastActivityAt: at,
		});
		return this.emit({
			surfaceId,
			workspaceId: existing.workspaceId,
			from: existing.state,
			to: "ended",
			cause,
			at,
		});
	}

	/**
	 * The stuck-state corrector's only entry point. It may act ONLY on a session
	 * currently in `working` — the spec's "correct stuck states, never invent
	 * them" rule expressed as code rather than as a comment in the caller.
	 */
	correctStuck(
		surfaceId: string,
		to: AgentSessionState,
		at = Date.now(),
	): AgentSessionTransition | null {
		const existing = this.records.get(surfaceId);
		if (!existing || existing.state !== "working" || to === "working") {
			return null;
		}
		this.records.set(surfaceId, { ...existing, state: to, lastActivityAt: at });
		return this.emit({
			surfaceId,
			workspaceId: existing.workspaceId,
			from: "working",
			to,
			cause: "transcript-correction",
			at,
		});
	}

	/**
	 * Boot reconciliation: any loaded session whose pane is gone from the layout
	 * is ended. Returns the transitions so the caller can log and persist them.
	 */
	reconcile(
		livePaneIds: Set<string>,
		at = Date.now(),
	): AgentSessionTransition[] {
		const transitions: AgentSessionTransition[] = [];
		for (const record of this.records.values()) {
			if (record.state === "ended" || livePaneIds.has(record.surfaceId)) {
				continue;
			}
			const transition = this.markEnded(record.surfaceId, "reconcile", at);
			if (transition) transitions.push(transition);
		}
		return transitions;
	}

	/** Sessions in `working` with no activity for `staleMs`. */
	stuckCandidates(staleMs: number, now = Date.now()): AgentSessionRecord[] {
		return [...this.records.values()].filter(
			(record) =>
				record.state === "working" && now - record.lastActivityAt >= staleMs,
		);
	}

	private emit(transition: AgentSessionTransition): AgentSessionTransition {
		for (const fn of this.listeners) {
			try {
				fn(transition);
			} catch {
				// A broken subscriber must not stop the others, and must never
				// unwind a hook request.
			}
		}
		return transition;
	}
}
