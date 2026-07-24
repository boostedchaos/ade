import {
	BRANCH_PREFIX_MODES,
	EXTERNAL_APPS,
	projects,
	workspaces,
} from "@superset/local-db";
import { localDb } from "@ade/server-core/local-db";
import { getDaemonTerminalManager } from "@ade/server-core/terminal";
import {
	hideProject,
	updateActiveWorkspaceIfRemoved,
} from "@ade/server-core/workspaces/db-helpers";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import simpleGit from "simple-git";
import { z } from "zod/v4";
import {
	getDefaultBranch,
	getGitAuthorName,
	refreshDefaultBranch,
	sanitizeAuthorPrefix,
} from "../lib/git";
import {
	deleteProjectIcon,
	saveProjectIconFromDataUrl,
} from "../lib/project-icons";
import { authedProcedure, router } from "../trpc";

/**
 * Categories (projects) — server mirror of the desktop router paths the
 * renderer calls (PHASE_2: the desktop router tree IS the API contract).
 */

const CATEGORY_COLORS = [
	"#8b7355",
	"#6b8e23",
	"#4682b4",
	"#9370db",
	"#cd5c5c",
	"#2e8b57",
];

export const projectsRouter = router({
	get: authedProcedure
		.input(z.object({ id: z.string() }))
		.query(({ input }) => {
			const project = localDb
				.select()
				.from(projects)
				.where(eq(projects.id, input.id))
				.get();
			if (!project) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: `Project ${input.id} not found`,
				});
			}
			return project;
		}),

	createCategory: authedProcedure
		.input(
			z.object({
				name: z.string().min(1),
				color: z.string().optional(),
			}),
		)
		.mutation(({ input }) => {
			const allProjects = localDb.select().from(projects).all();
			const maxTabOrder = allProjects.reduce(
				(max, p) => (p.tabOrder != null && p.tabOrder > max ? p.tabOrder : max),
				-1,
			);
			return localDb
				.insert(projects)
				.values({
					mainRepoPath: "",
					name: input.name,
					color:
						input.color ??
						(CATEGORY_COLORS[allProjects.length % CATEGORY_COLORS.length] ?? "#8b7355"),
					tabOrder: maxTabOrder + 1,
				})
				.returning()
				.get();
		}),

	update: authedProcedure
		.input(
			z.object({
				id: z.string(),
				patch: z.object({
					name: z.string().trim().min(1).optional(),
					color: z.string().optional(),
					branchPrefixMode: z.enum(BRANCH_PREFIX_MODES).nullable().optional(),
					branchPrefixCustom: z.string().nullable().optional(),
					workspaceBaseBranch: z.string().nullable().optional(),
					worktreeBaseDir: z.string().nullable().optional(),
					hideImage: z.boolean().optional(),
					defaultApp: z.enum(EXTERNAL_APPS).nullable().optional(),
				}),
			}),
		)
		.mutation(({ input }) => {
			const project = localDb
				.select()
				.from(projects)
				.where(eq(projects.id, input.id))
				.get();
			if (!project) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: `Project ${input.id} not found`,
				});
			}
			localDb
				.update(projects)
				.set({
					...(input.patch.name !== undefined && { name: input.patch.name }),
					...(input.patch.color !== undefined && { color: input.patch.color }),
					...(input.patch.branchPrefixMode !== undefined && {
						branchPrefixMode: input.patch.branchPrefixMode,
					}),
					...(input.patch.branchPrefixCustom !== undefined && {
						branchPrefixCustom: input.patch.branchPrefixCustom,
					}),
					...(input.patch.workspaceBaseBranch !== undefined && {
						workspaceBaseBranch: input.patch.workspaceBaseBranch,
					}),
					...(input.patch.worktreeBaseDir !== undefined && {
						worktreeBaseDir: input.patch.worktreeBaseDir,
					}),
					...(input.patch.hideImage !== undefined && {
						hideImage: input.patch.hideImage,
					}),
					...(input.patch.defaultApp !== undefined && {
						defaultApp: input.patch.defaultApp,
					}),
					lastOpenedAt: Date.now(),
				})
				.where(eq(projects.id, input.id))
				.run();
			return { success: true };
		}),

	reorder: authedProcedure
		.input(z.object({ fromIndex: z.number(), toIndex: z.number() }))
		.mutation(({ input }) => {
			const active = localDb
				.select()
				.from(projects)
				.all()
				.filter((p) => p.tabOrder !== null)
				.sort((a, b) => (a.tabOrder ?? 0) - (b.tabOrder ?? 0));
			const { fromIndex, toIndex } = input;
			if (
				fromIndex < 0 ||
				fromIndex >= active.length ||
				toIndex < 0 ||
				toIndex >= active.length
			) {
				throw new Error("Invalid fromIndex or toIndex");
			}
			const [removed] = active.splice(fromIndex, 1);
			active.splice(toIndex, 0, removed);
			for (let i = 0; i < active.length; i++) {
				localDb
					.update(projects)
					.set({ tabOrder: i })
					.where(eq(projects.id, active[i].id))
					.run();
			}
			return { success: true };
		}),

	close: authedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ input }) => {
			const project = localDb
				.select()
				.from(projects)
				.where(eq(projects.id, input.id))
				.get();
			if (!project) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
			}

			const projectWorkspaces = localDb
				.select()
				.from(workspaces)
				.where(eq(workspaces.projectId, input.id))
				.all();

			const terminal = getDaemonTerminalManager();
			let totalFailed = 0;
			for (const workspace of projectWorkspaces) {
				const result = await terminal.killByWorkspaceId(workspace.id);
				totalFailed += result.failed;
			}

			const closedIds = projectWorkspaces.map((w) => w.id);
			if (closedIds.length > 0) {
				localDb.delete(workspaces).where(inArray(workspaces.id, closedIds)).run();
			}

			hideProject(input.id);
			for (const id of closedIds) {
				updateActiveWorkspaceIfRemoved(id);
			}

			return {
				success: true,
				terminalWarning:
					totalFailed > 0
						? `${totalFailed} terminal process(es) may still be running`
						: undefined,
			};
		}),

	getBranches: authedProcedure
		.input(z.object({ projectId: z.string() }))
		.query(
			async ({
				input,
			}): Promise<{
				branches: Array<{
					name: string;
					lastCommitDate: number;
					isLocal: boolean;
					isRemote: boolean;
				}>;
				defaultBranch: string;
			}> => {
				const project = localDb
					.select()
					.from(projects)
					.where(eq(projects.id, input.projectId))
					.get();
				if (!project) {
					throw new Error(`Project ${input.projectId} not found`);
				}
				// ADE categories have no shared repo to list branches from.
				if (!project.mainRepoPath) {
					return { branches: [], defaultBranch: "main" };
				}

				const git = simpleGit(project.mainRepoPath);

				let hasOrigin = false;
				try {
					const remotes = await git.getRemotes();
					hasOrigin = remotes.some((r) => r.name === "origin");
				} catch {}

				const branchSummary = await git.branch(["-a"]);

				const localBranchSet = new Set<string>();
				const remoteBranchSet = new Set<string>();

				for (const name of Object.keys(branchSummary.branches)) {
					if (name.startsWith("remotes/origin/")) {
						if (name === "remotes/origin/HEAD") continue;
						remoteBranchSet.add(name.replace("remotes/origin/", ""));
					} else {
						localBranchSet.add(name);
					}
				}

				const branchMap = new Map<
					string,
					{ lastCommitDate: number; isLocal: boolean; isRemote: boolean }
				>();

				if (hasOrigin) {
					try {
						const remoteBranchInfo = await git.raw([
							"for-each-ref",
							"--sort=-committerdate",
							"--format=%(refname:short) %(committerdate:unix)",
							"refs/remotes/origin/",
						]);

						for (const line of remoteBranchInfo.trim().split("\n")) {
							if (!line) continue;
							const lastSpaceIdx = line.lastIndexOf(" ");
							let branch = line.substring(0, lastSpaceIdx);
							const timestamp = Number.parseInt(
								line.substring(lastSpaceIdx + 1),
								10,
							);

							if (branch.startsWith("origin/")) {
								branch = branch.replace("origin/", "");
							}
							if (branch === "HEAD") continue;

							branchMap.set(branch, {
								lastCommitDate: timestamp * 1000,
								isLocal: localBranchSet.has(branch),
								isRemote: true,
							});
						}
					} catch {
						for (const name of remoteBranchSet) {
							branchMap.set(name, {
								lastCommitDate: 0,
								isLocal: localBranchSet.has(name),
								isRemote: true,
							});
						}
					}
				}

				try {
					const localBranchInfo = await git.raw([
						"for-each-ref",
						"--sort=-committerdate",
						"--format=%(refname:short) %(committerdate:unix)",
						"refs/heads/",
					]);

					for (const line of localBranchInfo.trim().split("\n")) {
						if (!line) continue;
						const lastSpaceIdx = line.lastIndexOf(" ");
						const branch = line.substring(0, lastSpaceIdx);
						const timestamp = Number.parseInt(
							line.substring(lastSpaceIdx + 1),
							10,
						);

						if (branch === "HEAD") continue;

						// Remote takes precedence for date
						if (!branchMap.has(branch)) {
							branchMap.set(branch, {
								lastCommitDate: timestamp * 1000,
								isLocal: true,
								isRemote: remoteBranchSet.has(branch),
							});
						} else {
							const existing = branchMap.get(branch);
							if (existing) {
								existing.isLocal = true;
							}
						}
					}
				} catch {
					for (const name of localBranchSet) {
						if (!branchMap.has(name)) {
							branchMap.set(name, {
								lastCommitDate: 0,
								isLocal: true,
								isRemote: remoteBranchSet.has(name),
							});
						}
					}
				}

				const branches = Array.from(branchMap.entries()).map(
					([name, data]) => ({ name, ...data }),
				);

				// Sync with remote in case the default branch changed (e.g. master -> main)
				const remoteDefaultBranch = await refreshDefaultBranch(
					project.mainRepoPath,
				);

				const defaultBranch =
					remoteDefaultBranch ||
					project.defaultBranch ||
					(await getDefaultBranch(project.mainRepoPath));

				if (defaultBranch !== project.defaultBranch) {
					localDb
						.update(projects)
						.set({ defaultBranch })
						.where(eq(projects.id, input.projectId))
						.run();
				}

				// Sort: default branch first, then by date
				branches.sort((a, b) => {
					if (a.name === defaultBranch) return -1;
					if (b.name === defaultBranch) return 1;
					return b.lastCommitDate - a.lastCommitDate;
				});

				return { branches, defaultBranch };
			},
		),

	getGitAuthor: authedProcedure
		.input(z.object({ id: z.string() }))
		.query(async ({ input }) => {
			const project = localDb
				.select()
				.from(projects)
				.where(eq(projects.id, input.id))
				.get();
			if (!project) {
				return null;
			}

			// Repo-less categories fall back to the global git identity.
			const authorName = await getGitAuthorName(
				project.mainRepoPath || undefined,
			);
			if (!authorName) {
				return null;
			}

			return {
				name: authorName,
				prefix: sanitizeAuthorPrefix(authorName),
			};
		}),

	setProjectIcon: authedProcedure
		.input(
			z.object({
				id: z.string(),
				icon: z.string().nullable(),
			}),
		)
		.mutation(async ({ input }) => {
			const project = localDb
				.select()
				.from(projects)
				.where(eq(projects.id, input.id))
				.get();
			if (!project) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: `Project ${input.id} not found`,
				});
			}

			if (input.icon === null) {
				deleteProjectIcon(input.id);
				localDb
					.update(projects)
					.set({ iconUrl: null })
					.where(eq(projects.id, input.id))
					.run();
				return { iconUrl: null };
			}

			const iconUrl = await saveProjectIconFromDataUrl({
				projectId: input.id,
				dataUrl: input.icon,
			});
			localDb
				.update(projects)
				.set({ iconUrl })
				.where(eq(projects.id, input.id))
				.run();
			return { iconUrl };
		}),
});
