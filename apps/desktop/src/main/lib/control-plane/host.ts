import {
	getClaudeSettingsPath,
	readClaudeHookCoverage,
	writeClaudeSettings,
} from "@ade/server-core/agent-setup/agent-wrappers";
import { HistoryReader } from "@ade/server-core/terminal-history";
import { getWorkspaceRuntimeRegistry } from "@ade/server-core/workspace-runtime";
import { projects, workspaces, worktrees } from "@superset/local-db";
import { eq, isNull } from "drizzle-orm";
import type { BrowserWindow } from "electron";
import { getWorkspacesInVisualOrder } from "lib/trpc/routers/workspaces/procedures/query";
import {
	ControlError,
	type ControlPlaneHost,
	type ControlPlaneSnapshot,
	type NotificationSnapshot,
	type SnapshotPane,
	type SnapshotTab,
} from "../../../../../../packages/control-plane/src/index";
import { ingestAgentEvent, listAgentSessions } from "../agent-sessions";
import { appState } from "../app-state";
import {
	createNotification,
	listNotifications,
	markAllRead,
	markRead,
	type NotificationRecord,
	panesWithUnreadAttention,
} from "../attention";
import { localDb } from "../local-db";
import { mapAgentSessionState } from "../notifications/map-event-type";
import { extractWorkspaceIdFromUrl } from "../notifications/utils";
// Through the desktop shim, not @ade/server-core directly: importing it
// registers the Electron daemon-script path resolver as a side effect.
import { getTerminalHostClient } from "../terminal-host/client";
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

/**
 * The store's record and the wire's snapshot are structurally identical today.
 * Mapped explicitly anyway so that adding a field to the DB row does not
 * silently widen the socket's response shape.
 */
function toNotificationSnapshot(
	record: NotificationRecord,
): NotificationSnapshot {
	return {
		id: record.id,
		kind: record.kind,
		title: record.title,
		body: record.body,
		paneId: record.paneId,
		workspaceId: record.workspaceId,
		createdAt: record.createdAt,
		readAt: record.readAt,
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
			/**
			 * Live screen read straight from the daemon — no renderer hop and no
			 * attach/resize. Terminal sessions are keyed by paneId (verified at
			 * terminal/daemon/daemon-manager.ts), so the pane id IS the session id.
			 *
			 * The daemon THROWS `Session not found` for a pane with no live
			 * session, which is the ordinary case for a finished agent's pane. That
			 * is translated to null here so `read-screen` takes its history
			 * fallback quietly; any other failure is rethrown so the caller logs it
			 * rather than silently downgrading a real fault to "no session".
			 */
			readSnapshot: async (paneId, options) => {
				try {
					return await getTerminalHostClient().snapshot({
						sessionId: paneId,
						includeScrollback: options.includeScrollback,
						maxLines: options.maxLines,
					});
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (message.includes("Session not found")) return null;
					throw error;
				}
			},
		},

		/**
		 * Agent session tracking. `ingestEvent` deliberately routes through the
		 * same `ingestAgentEvent` the HTTP hook receiver uses — the control
		 * socket is a second door onto one registry, not a second registry.
		 */
		agents: {
			listSessions: () =>
				listAgentSessions().map((record) => ({
					surfaceId: record.surfaceId,
					workspaceId: record.workspaceId,
					agentKind: record.agentKind,
					sessionId: record.sessionId,
					transcriptPath: record.transcriptPath,
					state: record.state,
					pid: record.pid,
					lastActivityAt: record.lastActivityAt,
				})),

			ingestEvent: (input) => {
				const state = mapAgentSessionState(input.eventType);
				if (!state) {
					throw new ControlError(
						"BAD_REQUEST",
						`Unknown hook event "${input.eventType}"`,
					);
				}
				const transition = ingestAgentEvent({
					surfaceId: input.surfaceId,
					state,
					workspaceId: input.workspaceId ?? null,
					agentKind: input.agentKind,
					sessionId: input.sessionId,
					transcriptPath: input.transcriptPath,
				});
				return transition ? { from: transition.from, to: transition.to } : null;
			},

			setupHooks: (agent) => {
				const written = writeClaudeSettings();
				const coverage = readClaudeHookCoverage(written.settingsPath);
				return {
					agent,
					settingsPath: written.settingsPath,
					changed: written.changed,
					backupPath: written.backupPath,
					registered: coverage.registered,
					missing: coverage.missing,
				};
			},

			hooksStatus: (agent) => {
				const settingsPath = getClaudeSettingsPath();
				const coverage = readClaudeHookCoverage(settingsPath);
				return {
					agent,
					settingsPath,
					present: coverage.present,
					registered: coverage.registered,
					missing: coverage.missing,
				};
			},
		},

		/**
		 * Attention notifications. Same shape as `agents` above: a second front
		 * door onto main's single store, not a second store. `create` routes
		 * through `createNotification`, which is what emits the `notification`
		 * bus event and repaints the Dock badge, so a row made by `ade notify`
		 * and one made by an agent transition are indistinguishable downstream.
		 */
		notifications: {
			list: (options) =>
				listNotifications({ unreadOnly: options.unreadOnly }).map(
					toNotificationSnapshot,
				),
			create: (input) => {
				const record = createNotification({
					kind: input.kind,
					title: input.title,
					body: input.body,
					paneId: input.paneId,
					workspaceId: input.workspaceId,
				});
				return record ? toNotificationSnapshot(record) : null;
			},
			markRead: (id) => markRead(id),
			markAllRead: () => markAllRead(),
			panesWithUnreadAttention: () =>
				panesWithUnreadAttention(listNotifications()),
		},

		log: (level, message) => {
			const line = `[control-plane] ${message}`;
			if (level === "error") console.error(line);
			else if (level === "warn") console.warn(line);
			else console.log(line);
		},
	};
}
