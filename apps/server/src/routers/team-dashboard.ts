import { getAgentHome } from "@ade/server-core/agent-home";
import { resolveAgentWorktreePath } from "@ade/server-core/agent-worktree";
import { localDb } from "@ade/server-core/local-db";
import {
	buildActivity,
	buildRoster,
	buildRosterGitHub,
	buildWorkBoard,
	type TeamWorkspaceRef,
} from "@ade/server-core/team-dashboard";
import { workspaces } from "@superset/local-db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { authedProcedure, router } from "../trpc";

/**
 * Team dashboard (issue #51) — headless-server mirror of the desktop
 * `teamDashboard` router. Thin shell: resolve a project's agent rows to plain
 * TeamWorkspaceRefs (worktree path via resolveAgentWorktreePath, home via
 * getAgentHome — the same helpers mail.ts/workspaces.ts use) and hand them to
 * the shared server-core derivations.
 */
function resolveWorkspaceRefs(projectId: string): TeamWorkspaceRef[] {
	const rows = localDb
		.select()
		.from(workspaces)
		.where(
			and(eq(workspaces.projectId, projectId), isNull(workspaces.deletingAt)),
		)
		.all()
		.sort((a, b) => a.tabOrder - b.tabOrder);

	return rows.map((row) => ({
		workspaceId: row.id,
		name: row.name,
		iconUrl: row.iconUrl ?? null,
		branch: row.branch ?? null,
		worktreePath: resolveAgentWorktreePath(row.id, row.worktreeId),
		agentHome: getAgentHome(row.id),
	}));
}

export const teamDashboardRouter = router({
	roster: authedProcedure
		.input(z.object({ projectId: z.string() }))
		.query(({ input }) => buildRoster(resolveWorkspaceRefs(input.projectId))),

	rosterGitHub: authedProcedure
		.input(z.object({ projectId: z.string() }))
		.query(({ input }) =>
			buildRosterGitHub(resolveWorkspaceRefs(input.projectId)),
		),

	activity: authedProcedure
		.input(
			z.object({
				projectId: z.string(),
				limit: z.number().int().min(1).max(200).default(30),
			}),
		)
		.query(({ input }) =>
			buildActivity(resolveWorkspaceRefs(input.projectId), input.limit),
		),

	workBoard: authedProcedure
		.input(z.object({ projectId: z.string() }))
		.query(({ input }) => buildWorkBoard(resolveWorkspaceRefs(input.projectId))),
});
