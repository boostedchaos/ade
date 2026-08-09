import { requireEnum, requireString } from "../args";
import type { AgentSessionsHost } from "../host";
import { ControlError } from "../protocol";
import type { AuthenticatedSession, CommandRegistry } from "../server";
import { requirePane } from "../snapshot";
import { resolveTarget } from "../target-resolution";

/**
 * Status group (Mission Control Feature 1): `set-status` and `set-progress`.
 *
 * These exist for agents that have no hooks — anything that is not Claude Code
 * — so they can report for themselves. The important design point is that they
 * are NOT a second state machine: `set-status` lands in the SAME registry
 * ingest function the Claude hooks use, which is why an explicitly-declared
 * `needsInput` produces the attention row, the pane ring, the badges and the
 * jump-to-unread candidacy with no code in this file knowing any of that
 * exists. A parallel path would have had to reimplement all four, and would
 * have drifted the first time one of them changed.
 *
 * `--pane` is REQUIRED rather than defaulting to the focused pane. Reporting
 * your own state is a claim about a specific pane; defaulting to whatever the
 * human happens to be looking at would let a background agent silently flip
 * another agent's status. The CLI fills it from $ADE_SURFACE_ID, so the caller
 * inside a pane still types nothing.
 */

const STATES = ["working", "needsInput", "idle"] as const;

function requireAgents(session: AuthenticatedSession): AgentSessionsHost {
	const agents = session.host.agents;
	if (!agents) {
		throw new ControlError(
			"UNSUPPORTED",
			"This ADE build does not track agent sessions",
		);
	}
	return agents;
}

/**
 * PURE. Parse the `value` argument of `set-progress`.
 *
 * Returns null for the literal string "clear" — the CLI spells clearing as
 * `ade set-progress <pane> clear` rather than as an absent argument, so that a
 * shell variable expanding to nothing cannot silently clear a bar instead of
 * failing.
 */
export function parseProgressValue(value: unknown): number | null {
	if (value === "clear" || value === null) return null;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 100) {
		throw new ControlError(
			"BAD_REQUEST",
			'"value" must be an integer 0-100, or "clear"',
		);
	}
	return n;
}

export const statusCommands: CommandRegistry = {
	"set-status": (session, args) => {
		const agents = requireAgents(session);
		if (!agents.setState) {
			throw new ControlError(
				"UNSUPPORTED",
				"This ADE build does not accept explicit status reports",
			);
		}

		const snapshot = session.host.getSnapshot();
		const paneId = resolveTarget(snapshot, "pane", requireString(args, "pane"));
		const pane = requirePane(snapshot, paneId);
		if (pane.type !== "terminal") {
			throw new ControlError(
				"BAD_REQUEST",
				`Pane ${paneId} is a ${pane.type} pane; only terminal panes host agents`,
			);
		}

		const tab = snapshot.tabs.find((t) => t.id === pane.tabId);
		const transition = agents.setState({
			surfaceId: paneId,
			state: requireEnum(args, "state", STATES),
			workspaceId: tab?.workspaceId ?? null,
		});

		return {
			paneId,
			applied: transition !== null,
			from: transition?.from ?? null,
			to: transition?.to ?? null,
		};
	},

	"set-progress": (session, args) => {
		const agents = requireAgents(session);
		if (!agents.setProgress) {
			throw new ControlError(
				"UNSUPPORTED",
				"This ADE build does not track agent progress",
			);
		}

		const snapshot = session.host.getSnapshot();
		const paneId = resolveTarget(snapshot, "pane", requireString(args, "pane"));
		requirePane(snapshot, paneId);

		const value = parseProgressValue(args.value);
		if (!agents.setProgress(paneId, value)) {
			throw new ControlError(
				"NOT_FOUND",
				`Pane ${paneId} has no agent session; progress annotates an existing session and cannot create one`,
			);
		}
		return { paneId, progress: value };
	},
};
