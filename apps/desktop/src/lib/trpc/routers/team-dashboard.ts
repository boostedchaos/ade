import {
	buildActivity,
	buildRoster,
	buildRosterGitHub,
	buildWorkBoard,
	type TeamWorkspaceRef,
} from "@ade/server-core/team-dashboard";
import { z } from "zod";
import { publicProcedure, router } from "..";
import {
	type DashboardWorkspaceRow,
	getWorkspacesByProjectId,
} from "./workspaces/procedures/query";

/**
 * Team dashboard (issue #51) — desktop mirror of the server's `teamDashboard`
 * router. Thin shell: resolve the project's workspace rows to plain
 * TeamWorkspaceRefs and hand them to the shared server-core derivations.
 */
function toWorkspaceRefs(rows: DashboardWorkspaceRow[]): TeamWorkspaceRef[] {
	return rows.map((row) => ({
		workspaceId: row.id,
		name: row.name,
		iconUrl: row.iconUrl,
		branch: row.branch,
		worktreePath: row.worktreePath,
		agentHome: row.agentHome,
	}));
}

export const createTeamDashboardRouter = () => {
	return router({
		roster: publicProcedure
			.input(z.object({ projectId: z.string() }))
			.query(({ input }) =>
				buildRoster(toWorkspaceRefs(getWorkspacesByProjectId(input.projectId))),
			),

		rosterGitHub: publicProcedure
			.input(z.object({ projectId: z.string() }))
			.query(({ input }) =>
				buildRosterGitHub(
					toWorkspaceRefs(getWorkspacesByProjectId(input.projectId)),
				),
			),

		activity: publicProcedure
			.input(
				z.object({
					projectId: z.string(),
					limit: z.number().int().min(1).max(200).default(30),
				}),
			)
			.query(({ input }) =>
				buildActivity(
					toWorkspaceRefs(getWorkspacesByProjectId(input.projectId)),
					input.limit,
				),
			),

		workBoard: publicProcedure
			.input(z.object({ projectId: z.string() }))
			.query(({ input }) =>
				buildWorkBoard(
					toWorkspaceRefs(getWorkspacesByProjectId(input.projectId)),
				),
			),
	});
};
