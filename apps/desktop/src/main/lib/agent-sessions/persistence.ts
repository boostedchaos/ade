/**
 * Snapshot persistence for the AgentSession registry.
 *
 * The registry in memory is authoritative while the app runs; this table exists
 * so a restart does not lose which panes had agents in them. Every write is
 * best-effort — a DB error must never unwind a hook request, because the hook
 * is on Claude Code's critical path.
 */
import { agentSessions } from "@superset/local-db";
import { localDb } from "../local-db";
import type { AgentSessionRecord, AgentSessionState } from "./registry";

const STATES: AgentSessionState[] = ["working", "needsInput", "idle", "ended"];

function toState(value: string): AgentSessionState {
	return (STATES as string[]).includes(value)
		? (value as AgentSessionState)
		: "idle";
}

export function loadAgentSessions(): AgentSessionRecord[] {
	try {
		return localDb
			.select()
			.from(agentSessions)
			.all()
			.map((row) => ({
				surfaceId: row.surfaceId,
				workspaceId: row.workspaceId ?? null,
				agentKind: row.agentKind,
				sessionId: row.sessionId ?? null,
				transcriptPath: row.transcriptPath ?? null,
				state: toState(row.state),
				pid: row.pid ?? null,
				lastActivityAt: row.lastActivityAt,
			}));
	} catch (error) {
		console.error("[agent-sessions] Failed to load snapshots:", error);
		return [];
	}
}

export function saveAgentSession(record: AgentSessionRecord): void {
	try {
		const now = Date.now();
		localDb
			.insert(agentSessions)
			.values({
				surfaceId: record.surfaceId,
				workspaceId: record.workspaceId,
				agentKind: record.agentKind,
				sessionId: record.sessionId,
				transcriptPath: record.transcriptPath,
				state: record.state,
				pid: record.pid,
				lastActivityAt: record.lastActivityAt,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: agentSessions.surfaceId,
				set: {
					workspaceId: record.workspaceId,
					agentKind: record.agentKind,
					sessionId: record.sessionId,
					transcriptPath: record.transcriptPath,
					state: record.state,
					pid: record.pid,
					lastActivityAt: record.lastActivityAt,
					updatedAt: now,
				},
			})
			.run();
	} catch (error) {
		console.error("[agent-sessions] Failed to persist snapshot:", error);
	}
}
