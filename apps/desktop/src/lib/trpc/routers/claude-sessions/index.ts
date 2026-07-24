import {
	importClaudeSession,
	listSessionsForRepo,
	readLatestSessionStats,
	scanClaudeSessions,
} from "@ade/server-core/claude-sessions";
import { workspaces } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
	getAgentHome,
	getAgentMemoryDir,
	getAgentWorktreePath,
} from "main/lib/agent-home";
import { localDb } from "main/lib/local-db";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import { getWorkspacePath } from "../workspaces/utils/worktree";

/**
 * Import native `claude` CLI sessions into a ADE Workspace (issue #27).
 *
 * Minimal desktop mirror of the ade-server `claudeSessions` router so the
 * shared renderer's session picker works identically in the Electron app. All
 * logic lives in the Electron-free `@ade/server-core/claude-sessions` core;
 * fuller desktop-native UX polish is tracked in #28.
 */
export const createClaudeSessionsRouter = () => {
	return router({
		list: publicProcedure
			.input(z.object({ repoPath: z.string().optional() }).optional())
			.query(async ({ input }) => {
				if (input?.repoPath) {
					const sessions = await listSessionsForRepo(input.repoPath);
					return sessions.length
						? [{ repoPath: input.repoPath, sessions }]
						: [];
				}
				return scanClaudeSessions();
			}),

		/**
		 * Live stats for the newest Claude Code session in a worktree (issue
		 * #36): active model + context-size estimate from the latest assistant
		 * turn. Polled by the session tab strip; null when the worktree has no
		 * Claude sessions (non-Claude runtimes degrade to name-only tabs).
		 */
		stats: publicProcedure
			.input(z.object({ worktreePath: z.string() }))
			.query(({ input }) => readLatestSessionStats(input.worktreePath)),

		import: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					sessionId: z.string().uuid(),
					sourceRepoPath: z.string().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				const workspace = localDb
					.select()
					.from(workspaces)
					.where(eq(workspaces.id, input.workspaceId))
					.get();
				if (!workspace) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: `Workspace ${input.workspaceId} not found`,
					});
				}

				const worktreePath =
					getWorkspacePath(workspace) ?? getAgentWorktreePath(workspace.id);

				try {
					return await importClaudeSession({
						sessionId: input.sessionId,
						sourceRepoPath: input.sourceRepoPath,
						worktreePath,
						agentMemoryDir: getAgentMemoryDir(workspace.id),
						agentHome: getAgentHome(workspace.id),
					});
				} catch (error) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							error instanceof Error
								? error.message
								: "Failed to import session",
					});
				}
			}),
	});
};
