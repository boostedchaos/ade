import { HistoryReader } from "@ade/server-core/terminal-history";
import { getWorkspaceRuntimeRegistry } from "@ade/server-core/workspace-runtime";
import { projects, workspaces, worktrees } from "@superset/local-db";
import { eq, isNull } from "drizzle-orm";
import type { BrowserWindow } from "electron";
import { getWorkspacesInVisualOrder } from "lib/trpc/routers/workspaces/procedures/query";
import type {
	ControlPlaneHost,
	ControlPlaneSnapshot,
	SnapshotPane,
	SnapshotTab,
} from "../../../../../../packages/control-plane/src/index";
import { appState } from "../app-state";
import { localDb } from "../local-db";
import { extractWorkspaceIdFromUrl } from "../notifications/utils";
import type { RendererBridge } from "./renderer-bridge";

/**
 * Desktop adapter: turns Electron/main facilities into the Electron-free
 * ControlPlaneHost interface the package is written against.
 *
 * READS BYPASS THE RENDERER — this is the Phase 1 finding the lane was asked
 * to verify first, and it held. `appState.data.tabsState` is a live mirror of
 * the renderer's tabs store (the zustand `persist` middleware writes through
 * `uiState.tabs.set` on every change), and main already reads it this way in
 * lib/notifications/server.ts. Combined with the window URL for the focused
 * workspace and getWorkspacesInVisualOrder() for rail order, every list-* and
 * every target resolution is served in-process. The renderer bridge is
 * therefore MUTATIONS ONLY.
 */

/**
 * The tabs mirror carries `layout` on each tab at runtime — the ui-state
 * router's zod schema requires it (`tabSchema.layout: mosaicNodeSchema`) — but
 * the shared `BaseTab` TYPE omits it, because layout is nominally renderer
 * state. Reading it needs this local widening; it is not an unchecked cast of
 * something that might be absent.
 */
interface MirroredTab {
	id: string;
	name: string;
	userTitle?: string;
	workspaceId: string;
	createdAt: number;
	layout?: unknown;
}

export function buildSnapshot(
	getWindow: () => BrowserWindow | null,
): ControlPlaneSnapshot {
	const tabsState = appState.data?.tabsState;
	const rawTabs = (tabsState?.tabs ?? []) as unknown as MirroredTab[];

	const tabs: SnapshotTab[] = rawTabs.map((tab) => ({
		id: tab.id,
		name: tab.name,
		userTitle: tab.userTitle,
		workspaceId: tab.workspaceId,
		createdAt: tab.createdAt,
	}));

	const tabLayouts: Record<string, unknown> = {};
	for (const tab of rawTabs) {
		if (tab.layout !== undefined) tabLayouts[tab.id] = tab.layout;
	}

	const panes: Record<string, SnapshotPane> = {};
	for (const [id, pane] of Object.entries(tabsState?.panes ?? {})) {
		panes[id] = {
			id: pane.id,
			tabId: pane.tabId,
			type: pane.type,
			name: pane.name,
			userTitle: pane.userTitle,
			status: pane.status,
			cwd: pane.cwd ?? null,
			url: pane.url,
		};
	}

	const window = getWindow();
	const focusedWorkspaceId =
		window && !window.isDestroyed() && !window.webContents.isDestroyed()
			? extractWorkspaceIdFromUrl(window.webContents.getURL())
			: null;

	let workspaceOrder: string[] = [];
	try {
		workspaceOrder = getWorkspacesInVisualOrder();
	} catch {
		// DB not ready; an empty order degrades workspace refs to NOT_FOUND
		// rather than throwing INTERNAL out of every command.
	}

	return {
		panes,
		tabs,
		activeTabIds: tabsState?.activeTabIds ?? {},
		focusedPaneIds: tabsState?.focusedPaneIds ?? {},
		tabLayouts,
		focusedWorkspaceId,
		workspaceOrder,
	};
}

export function createControlPlaneHost(params: {
	appVersion: string;
	getWindow: () => BrowserWindow | null;
	bridge: RendererBridge;
}): ControlPlaneHost {
	const { appVersion, getWindow, bridge } = params;

	return {
		appVersion,

		getSnapshot: () => buildSnapshot(getWindow),

		listWorkspaces: () => {
			const rows = localDb
				.select({
					id: workspaces.id,
					name: workspaces.name,
					projectId: workspaces.projectId,
					type: workspaces.type,
					branch: workspaces.branch,
					worktreePath: worktrees.path,
					mainRepoPath: projects.mainRepoPath,
				})
				.from(workspaces)
				.leftJoin(worktrees, eq(workspaces.worktreeId, worktrees.id))
				.leftJoin(projects, eq(workspaces.projectId, projects.id))
				.where(isNull(workspaces.deletingAt))
				.all();

			return rows.map((row) => ({
				id: row.id,
				name: row.name,
				projectId: row.projectId,
				type: row.type,
				// A worktree workspace lives at the worktree path; a branch
				// workspace is the project's main checkout.
				path: row.worktreePath ?? row.mainRepoPath ?? null,
				branch: row.branch,
			}));
		},

		resolveProjectId: (project: string) => {
			const byId = localDb
				.select({ id: projects.id })
				.from(projects)
				.where(eq(projects.id, project))
				.get();
			if (byId) return byId.id;

			const byName = localDb
				.select({ id: projects.id, name: projects.name })
				.from(projects)
				.all()
				.find((row) => row.name?.toLowerCase() === project.toLowerCase());
			return byName?.id ?? null;
		},

		dispatchToRenderer: (op) => bridge.dispatch(op),

		terminal: {
			write: (paneId, data) => {
				getWorkspaceRuntimeRegistry()
					.getDefault()
					.terminal.write({ paneId, data });
			},
			getSession: (paneId) =>
				getWorkspaceRuntimeRegistry().getDefault().terminal.getSession(paneId),
			readScrollback: async (workspaceId, paneId) => {
				const reader = new HistoryReader(workspaceId, paneId);
				if (!(await reader.exists())) return null;
				return reader.readScrollback();
			},
		},

		log: (level, message) => {
			const line = `[control-plane] ${message}`;
			if (level === "error") console.error(line);
			else if (level === "warn") console.warn(line);
			else console.log(line);
		},
	};
}
