import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentHome,
	getAgentMemoryDir,
	getAgentWorktreePath,
} from "@ade/server-core/agent-home";
import {
	beginAgentInit,
	retryAgentInit,
} from "@ade/server-core/agent-init";
import { MEMORY_SCAFFOLD_ENABLED } from "@ade/server-core/feature-flags";
import { localDb } from "@ade/server-core/local-db";
import { getDaemonTerminalManager } from "@ade/server-core/terminal";
import type { WorkspaceInitProgress } from "@ade/server-core/types/workspace-init";
import { workspaceInitManager } from "@ade/server-core/workspace-init-manager";
import {
	activateProject,
	clearWorkspaceDeletingStatus,
	deleteWorkspace,
	deleteWorktreeRecord,
	getMaxWorkspaceTabOrder,
	getProject,
	getWorkspace,
	hideProjectIfNoWorkspaces,
	markWorkspaceAsDeleting,
	setLastActiveWorkspace,
	updateActiveWorkspaceIfRemoved,
} from "@ade/server-core/workspaces/db-helpers";
import { projects, workspaces, worktrees } from "@superset/local-db";
import { observable } from "@trpc/server/observable";
import { eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { authedProcedure, router } from "../trpc";

/** One entry in an agent's memory/skill surface (mirrors the desktop shape). */
interface AgentFileEntry {
	label: string;
	group: "Memory" | "Skills" | "Mail" | "Worktree" | "Imported";
	absolutePath: string;
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
 * List an agent's memory surface (canonical memory files, skill definitions,
 * worktree bridge files). Headless port of the desktop collectAgentFiles —
 * all three path helpers come from server-core/agent-home. Tolerates missing
 * dirs (returns what exists on disk).
 */
function collectAgentFiles(agentId: string): AgentFileEntry[] {
	const entries: AgentFileEntry[] = [];

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

	const claudeMd = join(getAgentWorktreePath(agentId), "CLAUDE.md");
	if (existsSync(claudeMd)) {
		entries.push({
			label: "CLAUDE.md",
			group: "Worktree",
			absolutePath: claudeMd,
			relativeToWorktree: "CLAUDE.md",
		});
	}

	// Imported native-Claude-session transcripts (issue #27). Rendered Markdown
	// under <agent-home>/imported/ — kept separate from the agent's live history.
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

/** Returns workspace IDs in sidebar visual order (by project.tabOrder, then workspace.tabOrder). */
function getWorkspacesInVisualOrder(): string[] {
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
 * Agents (workspaces) — server mirror of the desktop router paths. Thin
 * shells over the extracted core (agent-init, workspace-init-manager,
 * db-helpers all live in server-core).
 */

const createAgentInput = z.object({
	projectId: z.string(),
	name: z.string().min(1),
	role: z
		.string()
		.trim()
		.max(280)
		.optional()
		.transform((v) => (v ? v : undefined)),
	runtime: z.enum(["claude", "codex", "opencode"]).default("claude"),
	repo: z
		.discriminatedUnion("type", [
			z.object({ type: z.literal("init") }),
			z.object({ type: z.literal("clone"), url: z.string().min(1) }),
		])
		.default({ type: "init" }),
	// Create-from-existing (issue #41): copy the source agent's persona
	// (AGENT.md re-stamped, USER.md, skills/**) over the fresh scaffold.
	// `includeLessons` additionally carries MEMORY.md's "## Lessons" section.
	duplicateFrom: z
		.object({
			agentId: z.string().min(1),
			includeLessons: z.boolean().default(false),
		})
		.optional(),
});

export const workspacesRouter = router({
	get: authedProcedure
		.input(z.object({ id: z.string() }))
		.query(({ input }) => {
			const workspace = localDb
				.select()
				.from(workspaces)
				.where(eq(workspaces.id, input.id))
				.get();
			if (!workspace) {
				throw new Error(`Workspace ${input.id} not found`);
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
			return {
				...workspace,
				type: workspace.type as "worktree" | "branch",
				worktreePath: worktree?.path ?? "",
				role: null,
				project: project
					? {
							id: project.id,
							name: project.name,
							mainRepoPath: project.mainRepoPath,
							githubOwner: project.githubOwner ?? null,
							defaultBranch: project.defaultBranch ?? null,
						}
					: null,
				worktree: worktree ?? null,
			};
		}),

	getAll: authedProcedure.query(() => localDb.select().from(workspaces).all()),

	/** Agent Files panel — an agent's memory/skill/worktree bridge files. */
	listAgentFiles: authedProcedure
		.input(z.object({ workspaceId: z.string() }))
		.query(({ input }): AgentFileEntry[] => {
			if (!MEMORY_SCAFFOLD_ENABLED) return [];
			return collectAgentFiles(input.workspaceId);
		}),

	getAllGrouped: authedProcedure.query(() => {
		const activeProjects = localDb
			.select()
			.from(projects)
			.where(isNotNull(projects.tabOrder))
			.all();
		const allWorktrees = localDb.select().from(worktrees).all();
		const worktreePathById = new Map(allWorktrees.map((w) => [w.id, w.path]));
		const allWorkspaces = localDb.select().from(workspaces).all();

		return activeProjects
			.sort((a, b) => (a.tabOrder ?? 0) - (b.tabOrder ?? 0))
			.map((project) => ({
				project: {
					id: project.id,
					name: project.name,
					color: project.color,
					tabOrder: project.tabOrder ?? 0,
					githubOwner: project.githubOwner ?? null,
					mainRepoPath: project.mainRepoPath,
					hideImage: Boolean(project.hideImage),
					iconUrl: project.iconUrl ?? null,
				},
				workspaces: allWorkspaces
					.filter((w) => w.projectId === project.id)
					.sort((a, b) => (a.tabOrder ?? 0) - (b.tabOrder ?? 0))
					.map((w) => ({
						...w,
						worktreePath: w.worktreeId
							? (worktreePathById.get(w.worktreeId) ?? "")
							: "",
					})),
			}));
	}),

	getPreviousWorkspace: authedProcedure
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

	getNextWorkspace: authedProcedure
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

	createAgent: authedProcedure.input(createAgentInput).mutation(({ input }) => {
		const project = getProject(input.projectId);
		if (!project) {
			throw new Error(`Category ${input.projectId} not found`);
		}

		// Create-from-existing: resolve the source agent up front so a bad id
		// fails the call instead of the background init job.
		let duplicateFrom:
			| {
					sourceAgentId: string;
					sourceAgentName: string;
					includeLessons: boolean;
			  }
			| undefined;
		if (input.duplicateFrom) {
			const source = getWorkspace(input.duplicateFrom.agentId);
			if (!source) {
				throw new Error(
					`Source agent ${input.duplicateFrom.agentId} not found`,
				);
			}
			duplicateFrom = {
				sourceAgentId: source.id,
				sourceAgentName: source.name,
				includeLessons: input.duplicateFrom.includeLessons,
			};
		}

		const agentId = randomUUID();
		const worktreePath = getAgentWorktreePath(agentId);
		const branch = "main"; // placeholder; init job resolves the real one

		const worktree = localDb
			.insert(worktrees)
			.values({
				projectId: input.projectId,
				path: worktreePath,
				branch,
				baseBranch: branch,
				gitStatus: null,
			})
			.returning()
			.get();

		const workspace = localDb
			.insert(workspaces)
			.values({
				id: agentId,
				projectId: input.projectId,
				worktreeId: worktree.id,
				type: "worktree",
				branch,
				name: input.name,
				runtime: input.runtime,
				isUnnamed: false,
				tabOrder: getMaxWorkspaceTabOrder(input.projectId) + 1,
			})
			.returning()
			.get();

		activateProject(project);
		setLastActiveWorkspace(agentId);

		beginAgentInit(agentId, {
			categoryId: input.projectId,
			worktreeId: worktree.id,
			agentName: input.name,
			role: input.role,
			runtime: input.runtime,
			source: input.repo,
			duplicateFrom,
		});

		return {
			workspace,
			worktreePath,
			worktreeId: worktree.id,
			isInitializing: true,
		};
	}),

	getInitProgress: authedProcedure
		.input(z.object({ workspaceId: z.string() }))
		.query(
			({ input }) =>
				workspaceInitManager.getProgress(input.workspaceId) ?? null,
		),

	onInitProgress: authedProcedure
		.input(
			z.object({ workspaceIds: z.array(z.string()).optional() }).optional(),
		)
		.subscription(({ input }) =>
			observable<WorkspaceInitProgress>((emit) => {
				const handler = (progress: WorkspaceInitProgress) => {
					if (
						input?.workspaceIds &&
						!input.workspaceIds.includes(progress.workspaceId)
					) {
						return;
					}
					emit.next(progress);
				};
				for (const progress of workspaceInitManager.getAllProgress()) {
					handler(progress);
				}
				workspaceInitManager.on("progress", handler);
				return () => workspaceInitManager.off("progress", handler);
			}),
		),

	retryInit: authedProcedure
		.input(
			z.object({
				workspaceId: z.string(),
				deduplicateBranchName: z.boolean().optional(),
			}),
		)
		.mutation(({ input }) => {
			// ponytail: ade agents own standalone repos — retryAgentInit re-runs
			// the whole init job; the desktop's legacy shared-worktree retry path
			// doesn't apply server-side.
			if (!retryAgentInit(input.workspaceId)) {
				throw new Error("No retryable init job for this agent");
			}
			return { success: true };
		}),

	canDelete: authedProcedure
		.input(z.object({ id: z.string(), skipGitChecks: z.boolean().optional() }))
		.query(async ({ input }) => {
			const workspace = getWorkspace(input.id);
			const base = {
				activeTerminalCount: 0,
				hasChanges: false,
				hasUnpushedCommits: false,
			};
			if (!workspace) {
				return {
					...base,
					canDelete: false,
					reason: "Workspace not found",
					workspace: null,
				};
			}
			if (workspace.deletingAt) {
				return {
					...base,
					canDelete: false,
					reason: "Deletion already in progress",
					workspace: null,
				};
			}
			const activeTerminalCount =
				await getDaemonTerminalManager().getSessionCountByWorkspaceId(input.id);
			// ponytail: agents own standalone repos, so uncommitted/unpushed checks
			// are skipped v1 — add git status checks if silent data loss ever bites.
			return {
				...base,
				canDelete: true,
				reason: null,
				workspace,
				warning: null,
				activeTerminalCount,
			};
		}),

	delete: authedProcedure
		.input(
			z.object({
				id: z.string(),
				deleteLocalBranch: z.boolean().optional(),
				force: z.boolean().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			const workspace = getWorkspace(input.id);
			if (!workspace) {
				return { success: false, error: "Workspace not found" };
			}

			markWorkspaceAsDeleting(input.id);
			updateActiveWorkspaceIfRemoved(input.id);

			if (workspaceInitManager.isInitializing(input.id)) {
				workspaceInitManager.cancel(input.id);
				try {
					await workspaceInitManager.waitForInit(input.id, 30000);
				} catch {
					clearWorkspaceDeletingStatus(input.id);
					return {
						success: false,
						error: "Failed to cancel agent initialization. Please try again.",
					};
				}
			}

			const terminalResult = await getDaemonTerminalManager().killByWorkspaceId(
				input.id,
			);

			// ADE agents live entirely under ~/.ade/agents/<id> — removing
			// that directory removes the repo, memory, and CLI home in one shot.
			const agentHome = getAgentHome(input.id);
			try {
				if (existsSync(agentHome)) {
					rmSync(agentHome, { recursive: true, force: true });
				}
			} catch (error) {
				if (!input.force) {
					clearWorkspaceDeletingStatus(input.id);
					return {
						success: false,
						error: `Failed to remove agent directory: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
			}

			deleteWorkspace(input.id);
			if (workspace.worktreeId) {
				deleteWorktreeRecord(workspace.worktreeId);
			}
			hideProjectIfNoWorkspaces(workspace.projectId);
			workspaceInitManager.clearJob(input.id);

			return {
				success: true,
				terminalWarning:
					terminalResult.failed > 0
						? `${terminalResult.failed} terminal process(es) may still be running`
						: undefined,
			};
		}),

	close: authedProcedure
		.input(z.object({ id: z.string() }))
		.mutation(async ({ input }) => {
			const workspace = getWorkspace(input.id);
			if (!workspace) {
				throw new Error("Workspace not found");
			}
			const terminalResult = await getDaemonTerminalManager().killByWorkspaceId(
				input.id,
			);
			deleteWorkspace(input.id);
			hideProjectIfNoWorkspaces(workspace.projectId);
			updateActiveWorkspaceIfRemoved(input.id);
			return {
				success: true,
				terminalWarning:
					terminalResult.failed > 0
						? `${terminalResult.failed} terminal process(es) may still be running`
						: undefined,
			};
		}),
});
