import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime } from "@superset/local-db";
import { projects, workspaces, worktrees } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
	getAgentHome,
	getAgentMemoryDir,
	getAgentWorktreePath,
} from "main/lib/agent-home";
import { MEMORY_SCAFFOLD_ENABLED } from "main/lib/feature-flags";
import { localDb } from "main/lib/local-db";
import { z } from "zod";
import { publicProcedure, router } from "../../..";
import { getWorkspace } from "../utils/db-helpers";
import { getWorkspacePath } from "../utils/worktree";

/** One entry in an agent's memory/skill surface. */
interface AgentFileEntry {
	/** Display label (e.g. "AGENT.md", "memories/foo.md", "skills/x/SKILL.md"). */
	label: string;
	/** Coarse grouping for the UI. */
	group: "Memory" | "Skills" | "Mail" | "Worktree" | "Imported";
	/** Absolute path on disk. */
	absolutePath: string;
	/** Worktree-relative path when the file lives inside the worktree, else null. */
	relativeToWorktree: string | null;
}

/** Recursively collect SKILL.md files under a skills dir (tolerates missing dir). */
function findSkillFiles(skillsDir: string): string[] {
	if (!existsSync(skillsDir)) return [];
	const results: string[] = [];
	const walk = (dir: string) => {
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const name = String(entry.name);
				const abs = join(dir, name);
				if (entry.isDirectory()) {
					walk(abs);
				} else if (name === "SKILL.md") {
					results.push(abs);
				}
			}
		} catch {
			// ignore unreadable dir
		}
	};
	walk(skillsDir);
	return results;
}

/**
 * List an agent's memory surface: canonical memory files, skill definitions,
 * and the worktree bridge files. Tolerates missing dirs (returns what exists).
 */
function collectAgentFiles(agentId: string): AgentFileEntry[] {
	const entries: AgentFileEntry[] = [];

	// Canonical memory dir
	const memoryDir = getAgentMemoryDir(agentId);
	for (const name of [
		"AGENT.md",
		"USER.md",
		"MEMORY.md",
		".writeback-protocol.md",
	]) {
		const abs = join(memoryDir, name);
		if (existsSync(abs)) {
			entries.push({
				label: name,
				group: "Memory",
				absolutePath: abs,
				relativeToWorktree: null,
			});
		}
	}

	// memories/*.md
	const memoriesDir = join(memoryDir, "memories");
	if (existsSync(memoriesDir)) {
		try {
			for (const name of readdirSync(memoriesDir)) {
				if (name.endsWith(".md")) {
					entries.push({
						label: `memories/${name}`,
						group: "Memory",
						absolutePath: join(memoriesDir, name),
						relativeToWorktree: null,
					});
				}
			}
		} catch {
			// ignore unreadable memories dir
		}
	}

	// skills/**/SKILL.md
	const skillsDir = join(getAgentHome(agentId), "skills");
	for (const abs of findSkillFiles(skillsDir)) {
		const rel = abs.slice(skillsDir.length + 1);
		entries.push({
			label: `skills/${rel}`,
			group: "Skills",
			absolutePath: abs,
			relativeToWorktree: null,
		});
	}

	// Agent-mail threads (issue #45): archived exchanges under mail/{inbox,sent}.
	const mailDir = join(getAgentHome(agentId), "mail");
	for (const box of ["inbox", "sent"] as const) {
		const dir = join(mailDir, box);
		if (!existsSync(dir)) continue;
		try {
			for (const name of readdirSync(dir)) {
				if (name.endsWith(".md")) {
					entries.push({
						label: `mail/${box}/${name}`,
						group: "Mail",
						absolutePath: join(dir, name),
						relativeToWorktree: null,
					});
				}
			}
		} catch {
			// ignore unreadable mail dir
		}
	}

	// Worktree bridge file(s)
	const claudeMd = join(getAgentWorktreePath(agentId), "CLAUDE.md");
	if (existsSync(claudeMd)) {
		entries.push({
			label: "CLAUDE.md",
			group: "Worktree",
			absolutePath: claudeMd,
			relativeToWorktree: "CLAUDE.md",
		});
	}

	// Imported native-Claude-session transcripts (issue #27), rendered as
	// read-only Markdown under <agent-home>/imported/.
	const importedDir = join(getAgentHome(agentId), "imported");
	if (existsSync(importedDir)) {
		try {
			for (const name of readdirSync(importedDir)) {
				if (name.endsWith(".md")) {
					entries.push({
						label: `imported/${name}`,
						group: "Imported",
						absolutePath: join(importedDir, name),
						relativeToWorktree: null,
					});
				}
			}
		} catch {
			// ignore unreadable imported dir
		}
	}

	return entries;
}

type WorktreePathMap = Map<string, string>;

/**
 * Reads an agent's role from the first heading of its CLAUDE.md
 * (e.g. "# Livy — Substack research" -> "Substack research"). Returns null
 * for non-agent workspaces or when no CLAUDE.md/role is present. Cheap +
 * cached by react-query; only the rail's ~handful of workspaces hit this.
 */
function readAgentRole(worktreePath: string): string | null {
	if (!worktreePath) return null;
	const claudeMd = join(worktreePath, "CLAUDE.md");
	if (!existsSync(claudeMd)) return null;
	try {
		const firstLine = readFileSync(claudeMd, "utf8").split("\n", 1)[0] ?? "";
		const match = firstLine.match(/^#\s*[^—-]+[—-]\s*(.+)$/);
		return match ? match[1].trim() : null;
	} catch {
		return null;
	}
}

/** Returns workspace IDs in sidebar visual order (by project.tabOrder, then workspace.tabOrder). */
export function getWorkspacesInVisualOrder(): string[] {
	const activeProjects = localDb
		.select()
		.from(projects)
		.where(isNotNull(projects.tabOrder))
		.all()
		.sort((a, b) => (a.tabOrder ?? 0) - (b.tabOrder ?? 0));

	const allWorkspaces = localDb
		.select()
		.from(workspaces)
		.where(isNull(workspaces.deletingAt))
		.all();

	const orderedIds: string[] = [];
	for (const project of activeProjects) {
		const projectWorkspaces = allWorkspaces
			.filter((w) => w.projectId === project.id)
			.sort((a, b) => a.tabOrder - b.tabOrder);
		for (const ws of projectWorkspaces) {
			orderedIds.push(ws.id);
		}
	}

	return orderedIds;
}

/**
 * One workspace row as getAllGrouped produces it, plus `agentHome`. Consumed by
 * the teamDashboard router (issue #51). Field set mirrors getAllGrouped's
 * per-workspace shape exactly.
 */
export interface DashboardWorkspaceRow {
	id: string;
	projectId: string;
	worktreeId: string | null;
	worktreePath: string;
	type: "worktree" | "branch";
	branch: string;
	name: string;
	tabOrder: number;
	createdAt: number;
	updatedAt: number;
	lastOpenedAt: number;
	isUnread: boolean;
	isUnnamed: boolean;
	iconUrl: string | null;
	runtime: AgentRuntime | null;
	role: string | null;
	/**
	 * Agent home directory (holds mail/, memory/, worktree/ …), derived from the
	 * workspace id via server-core's getAgentHome — paths are derived from the
	 * agent/workspace id, never stored in the DB (see
	 * packages/server-core/src/agent-home.ts). Nullable for non-agent rows,
	 * though derivation currently always resolves to a path.
	 */
	agentHome: string | null;
}

/**
 * Same per-workspace rows as getAllGrouped, filtered to a single project via a
 * DB where-clause and each augmented with `agentHome`. Sorted by tabOrder.
 */
export function getWorkspacesByProjectId(
	projectId: string,
): DashboardWorkspaceRow[] {
	const project = localDb
		.select()
		.from(projects)
		.where(eq(projects.id, projectId))
		.get();

	const worktreePathMap: WorktreePathMap = new Map(
		localDb
			.select()
			.from(worktrees)
			.all()
			.map((wt) => [wt.id, wt.path]),
	);

	const projectWorkspaces = localDb
		.select()
		.from(workspaces)
		.where(
			and(eq(workspaces.projectId, projectId), isNull(workspaces.deletingAt)),
		)
		.all()
		.sort((a, b) => a.tabOrder - b.tabOrder);

	return projectWorkspaces.map((workspace) => {
		let worktreePath = "";
		if (workspace.type === "worktree" && workspace.worktreeId) {
			worktreePath = worktreePathMap.get(workspace.worktreeId) ?? "";
		} else if (workspace.type === "branch") {
			worktreePath = project?.mainRepoPath ?? "";
		}

		return {
			...workspace,
			type: workspace.type as "worktree" | "branch",
			worktreePath,
			isUnread: workspace.isUnread ?? false,
			isUnnamed: workspace.isUnnamed ?? false,
			iconUrl: workspace.iconUrl ?? null,
			role: readAgentRole(worktreePath),
			agentHome: getAgentHome(workspace.id),
		};
	});
}

export const createQueryProcedures = () => {
	return router({
		get: publicProcedure
			.input(z.object({ id: z.string() }))
			.query(async ({ input }) => {
				const workspace = getWorkspace(input.id);
				if (!workspace) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: `Workspace ${input.id} not found`,
					});
				}

				const project = localDb
					.select()
					.from(projects)
					.where(eq(projects.id, workspace.projectId))
					.get();
				const worktree = workspace.worktreeId
					? localDb
							.select()
							.from(worktrees)
							.where(eq(worktrees.id, workspace.worktreeId))
							.get()
					: null;

				const resolvedWorktreePath = getWorkspacePath(workspace) ?? "";
				return {
					...workspace,
					type: workspace.type as "worktree" | "branch",
					worktreePath: resolvedWorktreePath,
					role: readAgentRole(resolvedWorktreePath),
					project: project
						? {
								id: project.id,
								name: project.name,
								mainRepoPath: project.mainRepoPath,
								githubOwner: project.githubOwner ?? null,
								defaultBranch: project.defaultBranch ?? null,
							}
						: null,
					worktree: worktree
						? {
								branch: worktree.branch,
								// Normalize to null to ensure consistent "incomplete init" detection in UI
								gitStatus: worktree.gitStatus ?? null,
							}
						: null,
				};
			}),

		getAll: publicProcedure.query(() => {
			return localDb
				.select()
				.from(workspaces)
				.where(isNull(workspaces.deletingAt))
				.all()
				.sort((a, b) => a.tabOrder - b.tabOrder);
		}),

		getAllGrouped: publicProcedure.query(() => {
			const activeProjects = localDb
				.select()
				.from(projects)
				.where(isNotNull(projects.tabOrder))
				.all();

			const allWorktrees = localDb.select().from(worktrees).all();
			const worktreePathMap: WorktreePathMap = new Map(
				allWorktrees.map((wt) => [wt.id, wt.path]),
			);

			const groupsMap = new Map<
				string,
				{
					project: {
						id: string;
						name: string;
						color: string;
						tabOrder: number;
						githubOwner: string | null;
						mainRepoPath: string;
						hideImage: boolean;
						iconUrl: string | null;
					};
					workspaces: Array<{
						id: string;
						projectId: string;
						worktreeId: string | null;
						worktreePath: string;
						type: "worktree" | "branch";
						branch: string;
						name: string;
						tabOrder: number;
						createdAt: number;
						updatedAt: number;
						lastOpenedAt: number;
						isUnread: boolean;
						isUnnamed: boolean;
						iconUrl: string | null;
						runtime: AgentRuntime | null;
						role: string | null;
					}>;
				}
			>();

			for (const project of activeProjects) {
				groupsMap.set(project.id, {
					project: {
						id: project.id,
						name: project.name,
						color: project.color,
						// biome-ignore lint/style/noNonNullAssertion: filter guarantees tabOrder is not null
						tabOrder: project.tabOrder!,
						githubOwner: project.githubOwner ?? null,
						mainRepoPath: project.mainRepoPath,
						hideImage: project.hideImage ?? false,
						iconUrl: project.iconUrl ?? null,
					},
					workspaces: [],
				});
			}

			const allWorkspaces = localDb
				.select()
				.from(workspaces)
				.where(isNull(workspaces.deletingAt))
				.all()
				.sort((a, b) => a.tabOrder - b.tabOrder);

			for (const workspace of allWorkspaces) {
				const group = groupsMap.get(workspace.projectId);
				if (group) {
					let worktreePath = "";
					if (workspace.type === "worktree" && workspace.worktreeId) {
						worktreePath = worktreePathMap.get(workspace.worktreeId) ?? "";
					} else if (workspace.type === "branch") {
						worktreePath = group.project.mainRepoPath;
					}

					group.workspaces.push({
						...workspace,
						type: workspace.type as "worktree" | "branch",
						worktreePath,
						isUnread: workspace.isUnread ?? false,
						isUnnamed: workspace.isUnnamed ?? false,
						iconUrl: workspace.iconUrl ?? null,
						role: readAgentRole(worktreePath),
					});
				}
			}

			return Array.from(groupsMap.values()).sort(
				(a, b) => a.project.tabOrder - b.project.tabOrder,
			);
		}),

		listAgentFiles: publicProcedure
			.input(z.object({ workspaceId: z.string() }))
			.query(({ input }): AgentFileEntry[] => {
				// Staged off for the video series: the panel stays present but
				// shows its empty state regardless of what's on disk.
				if (!MEMORY_SCAFFOLD_ENABLED) return [];
				return collectAgentFiles(input.workspaceId);
			}),

		getPreviousWorkspace: publicProcedure
			.input(z.object({ id: z.string() }))
			.query(({ input }) => {
				const orderedWorkspaceIds = getWorkspacesInVisualOrder();
				if (orderedWorkspaceIds.length === 0) return null;

				const currentIndex = orderedWorkspaceIds.indexOf(input.id);
				if (currentIndex === -1) return null;

				const prevIndex =
					currentIndex === 0
						? orderedWorkspaceIds.length - 1
						: currentIndex - 1;
				return orderedWorkspaceIds[prevIndex];
			}),

		getNextWorkspace: publicProcedure
			.input(z.object({ id: z.string() }))
			.query(({ input }) => {
				const orderedWorkspaceIds = getWorkspacesInVisualOrder();
				if (orderedWorkspaceIds.length === 0) return null;

				const currentIndex = orderedWorkspaceIds.indexOf(input.id);
				if (currentIndex === -1) return null;

				const nextIndex =
					currentIndex === orderedWorkspaceIds.length - 1
						? 0
						: currentIndex + 1;
				return orderedWorkspaceIds[nextIndex];
			}),
	});
};
