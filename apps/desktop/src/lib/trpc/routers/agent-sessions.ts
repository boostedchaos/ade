import { observable } from "@trpc/server/observable";
import {
	listAgentSessions,
	onAgentSessionsChanged,
} from "main/lib/agent-sessions";
import { publicProcedure, router } from "..";

/**
 * Renderer's view of the AgentSession registry (Mission Control Features 2/5).
 *
 * Query + subscription-driven invalidation, the same shape as the attention
 * router next door and for the same reason: the registry in main is the single
 * authority, so pushing records over the subscription would create a second
 * copy that can silently disagree with it after one dropped message.
 *
 * Only what the renderer actually draws is exposed. Transcript paths and pids
 * are deliberately absent — a filesystem path has no business crossing into a
 * window that renders remote web content.
 */
export const createAgentSessionsRouter = () => {
	return router({
		list: publicProcedure.query(() => {
			const sessions = listAgentSessions();
			return {
				sessions: sessions.map((record) => ({
					surfaceId: record.surfaceId,
					workspaceId: record.workspaceId,
					agentKind: record.agentKind,
					state: record.state,
					progress: record.progress,
					lastActivityAt: record.lastActivityAt,
				})),
				// paneId → 0-100. Built here so every consumer reads one map instead
				// of scanning the session list per pane.
				progressByPane: Object.fromEntries(
					sessions
						.filter((record) => record.progress !== null)
						.map((record) => [record.surfaceId, record.progress as number]),
				),
			};
		}),

		changed: publicProcedure.subscription(() => {
			return observable<{ at: number }>((emit) => {
				return onAgentSessionsChanged(() => {
					emit.next({ at: Date.now() });
				});
			});
		}),
	});
};
