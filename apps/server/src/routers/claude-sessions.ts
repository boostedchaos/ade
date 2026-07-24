import {
	getAgentHome,
	getAgentMemoryDir,
} from "@ade/server-core/agent-home";
import { resolveAgentWorktreePath } from "@ade/server-core/agent-worktree";
import {
	importClaudeSession,
	listSessionsForRepo,
	readLatestSessionStats,
	scanClaudeSessions,
} from "@ade/server-core/claude-sessions";
import { localDb } from "@ade/server-core/local-db";
import { workspaces } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { authedProcedure, router } from "../trpc";

/**
 * Import native `claude` CLI sessions into a ADE Workspace (issue #27).
 *
 * The `claude` binary stores sessions the user ran directly (outside ADE)
 * as JSONL transcripts under `~/.claude/projects/`. Those live on the machine
 * running ade-server, so discovery + parsing + import all happen here; the
 * browser only ever sees the resulting list and the import result. All the
 * heavy lifting is in the Electron-free `@ade/server-core/claude-sessions`
 * core so the same logic backs the desktop router (see #28).
 */
export const claudeSessionsRouter = router({
	/**
	 * Discover native Claude sessions grouped by the repo they ran in. Optionally
	 * scope to a single repo path. The UI groups these so the user can pick the
	 * session matching the repo backing their Workspace.
	 */
	list: authedProcedure
		.input(z.object({ repoPath: z.string().optional() }).optional())
		.query(async ({ input }) => {
			if (input?.repoPath) {
				const sessions = await listSessionsForRepo(input.repoPath);
				return sessions.length ? [{ repoPath: input.repoPath, sessions }] : [];
			}
			return scanClaudeSessions();
		}),

	/**
	 * Live stats for the newest Claude Code session in a worktree (issue #36):
	 * active model + context-size estimate from the latest assistant turn.
	 * Polled by the session tab strip; null when the worktree has no Claude
	 * sessions (non-Claude runtimes degrade to name-only tabs). Mirrors the
	 * desktop `claudeSessions.stats` procedure — both are thin shells over the
	 * shared server-core collector.
	 */
	stats: authedProcedure
		.input(z.object({ worktreePath: z.string() }))
		.query(({ input }) => readLatestSessionStats(input.worktreePath)),

	/**
	 * Bind a chosen native session to an existing Workspace's worktree: copy the
	 * transcript into the worktree's own project bucket (so `claude --resume`
	 * works there), render it to Markdown in the agent's files, and carry over
	 * the source repo's memory notes. Never creates git state — the Workspace/
	 * worktree must already exist.
	 */
	import: authedProcedure
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

			const worktreePath = resolveAgentWorktreePath(
				workspace.id,
				workspace.worktreeId,
			);

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
						error instanceof Error ? error.message : "Failed to import session",
				});
			}
		}),
});
