import { optionalString, requireString } from "../args";
import type { AgentSessionsHost } from "../host";
import { ControlError } from "../protocol";
import type { AuthenticatedSession, CommandRegistry } from "../server";

/**
 * Agent session tracking group (Mission Control Feature 2).
 *
 * These commands are a second FRONT DOOR onto main's session registry, not a
 * second implementation of it: `agent-event` lands in exactly the ingest
 * function the HTTP hook receiver calls, so a hook that reaches ADE over the
 * control socket and one that reaches it over localhost HTTP produce the same
 * record and the same `agent-state-changed` event.
 */

/** Agents whose hooks ADE can write today. */
const SUPPORTED_HOOK_AGENTS = new Set(["claude"]);
const KNOWN_HOOK_AGENTS = new Set(["claude", "codex", "opencode"]);

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

function requireHookAgent(args: Record<string, unknown>): string {
	const agent = (optionalString(args, "agent") ?? "claude").toLowerCase();
	if (SUPPORTED_HOOK_AGENTS.has(agent)) return agent;
	if (KNOWN_HOOK_AGENTS.has(agent)) {
		throw new ControlError(
			"UNSUPPORTED",
			`hooks setup ${agent}: not yet supported`,
		);
	}
	throw new ControlError("BAD_REQUEST", `Unknown agent "${agent}"`);
}

export const sessionCommands: CommandRegistry = {
	"agent-sessions": (session) => {
		const sessions = requireAgents(session).listSessions();
		return {
			sessions: sessions.map((record) => ({
				surfaceId: record.surfaceId,
				workspaceId: record.workspaceId,
				agentKind: record.agentKind,
				sessionId: record.sessionId,
				state: record.state,
				pid: record.pid,
				lastActivityAt: record.lastActivityAt,
			})),
		};
	},

	/**
	 * Called by `ade agent-event` from inside a Claude Code hook. `surfaceId` is
	 * required and comes from the caller's ADE_SURFACE_ID: the CLI resolves it,
	 * because a hook subprocess knows its own pane and the server would only be
	 * guessing from focus.
	 */
	"agent-event": (session, args) => {
		const agents = requireAgents(session);
		const transition = agents.ingestEvent({
			surfaceId: requireString(args, "surfaceId"),
			eventType: requireString(args, "event"),
			workspaceId: optionalString(args, "workspaceId"),
			sessionId: optionalString(args, "sessionId"),
			transcriptPath: optionalString(args, "transcriptPath"),
			agentKind: optionalString(args, "agentKind"),
		});
		return {
			applied: transition !== null,
			from: transition?.from ?? null,
			to: transition?.to ?? null,
		};
	},

	"hooks-setup": (session, args) => {
		const agents = requireAgents(session);
		return agents.setupHooks(requireHookAgent(args));
	},

	"hooks-status": (session, args) => {
		const agents = requireAgents(session);
		const agent = (optionalString(args, "agent") ?? "claude").toLowerCase();
		if (!KNOWN_HOOK_AGENTS.has(agent)) {
			throw new ControlError("BAD_REQUEST", `Unknown agent "${agent}"`);
		}
		if (!SUPPORTED_HOOK_AGENTS.has(agent)) {
			return {
				agent,
				settingsPath: null,
				present: false,
				supported: false,
				registered: [],
				missing: [],
			};
		}
		return { ...agents.hooksStatus(agent), supported: true };
	},
};
