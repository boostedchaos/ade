import type { ControlPlaneSnapshot } from "./snapshot";

/**
 * Everything the control plane needs from the Electron main process, injected
 * rather than imported, so this package stays Electron-free and unit-testable.
 * The desktop adapter lives at apps/desktop/src/main/lib/control-plane/.
 */

/**
 * A layout mutation forwarded to the renderer. Reads never come through here —
 * see snapshot.ts for why.
 *
 * The renderer counterpart of this type is declared in
 * apps/desktop/src/renderer/stores/tabs/control-plane-bridge.ts. It is a
 * structural duplicate on purpose: main must not import renderer code (it
 * would pull zustand and the whole store into the main bundle), and the
 * renderer cannot import this package without a workspace dependency edge.
 * Both sides validate at the boundary; the bridge's pure reducer is the single
 * place the shape is interpreted.
 */
export type BridgeOp =
	| {
			kind: "new-pane";
			paneType: "terminal" | "browser" | "file-viewer" | "devtools";
			/** Existing pane to split away from. */
			sourcePaneId: string;
			tabId: string;
			workspaceId: string;
			direction: "left" | "right" | "up" | "down";
			url?: string;
			path?: string;
			cwd?: string;
			command?: string;
			focus: boolean;
	  }
	| {
			kind: "new-split";
			sourcePaneId: string;
			tabId: string;
			direction: "left" | "right" | "up" | "down";
			cwd?: string;
			focus: boolean;
	  }
	| {
			kind: "split-off";
			paneId: string;
	  }
	| { kind: "focus-pane"; paneId: string; tabId: string; workspaceId: string }
	| { kind: "move-pane"; paneId: string; targetTabId: string }
	| { kind: "close-pane"; paneId: string }
	| {
			kind: "new-tab";
			workspaceId: string;
			cwd?: string;
			command?: string;
			focus: boolean;
	  }
	| { kind: "focus-workspace"; workspaceId: string }
	/**
	 * Workspace creation runs through the renderer for one reason: the only
	 * implementation is the `workspaces.create` tRPC mutation, and it is worth
	 * far more to reuse it than to re-derive git-worktree creation, branch
	 * prefixing and setup scripts in a second place.
	 */
	| { kind: "create-workspace"; projectId: string; name?: string };

export interface BridgeRequest {
	opId: string;
	op: BridgeOp;
}

export type BridgeReply =
	| { opId: string; result: Record<string, unknown> }
	| { opId: string; error: { code: string; message: string } };

export interface ControlPlaneHost {
	/** App version reported in the hello result. */
	appVersion: string;

	/**
	 * Current read model. Called per command rather than cached — the
	 * underlying mirror is a plain object read, and caching would add a second
	 * staleness window on top of the one documented in snapshot.ts.
	 */
	getSnapshot(): ControlPlaneSnapshot;

	/** Workspace rows for `list-workspaces`. */
	listWorkspaces(): Array<{
		id: string;
		name: string | null;
		projectId: string | null;
		type: string | null;
		path: string | null;
		branch: string | null;
	}>;

	/**
	 * Resolve a `--project` argument (an id or a name) to a project id.
	 * Returns null when nothing matches.
	 */
	resolveProjectId(project: string): string | null;

	/**
	 * Run a layout mutation in the renderer. Rejects with a ControlError
	 * (RENDERER_UNAVAILABLE / TIMEOUT / INTERNAL) rather than resolving an
	 * error shape, so handlers can stay linear.
	 */
	dispatchToRenderer(op: BridgeOp): Promise<Record<string, unknown>>;

	/** Terminal I/O — straight to the terminal-host daemon, no renderer hop. */
	terminal: {
		write(paneId: string, data: string): void;
		/** null when the pane has no live session. */
		getSession(
			paneId: string,
		): { isAlive: boolean; cwd: string; lastActive: number } | null;
		/**
		 * Persisted scrollback for a pane. See handlers/terminal.ts for the
		 * limitation this carries.
		 */
		readScrollback(workspaceId: string, paneId: string): Promise<string | null>;
		/** Read-only live screen read. Returns null when the daemon has no session. */
		readSnapshot?(
			paneId: string,
			options: { includeScrollback?: boolean; maxLines?: number },
		): Promise<{
			text: string;
			cols: number;
			rows: number;
			scrollbackLines: number;
			alternateScreen: boolean;
			cwd: string | null;
			isAlive: boolean;
			flushed: boolean;
		} | null>;
	};

	/**
	 * Agent session tracking (Feature 2). Optional so a host that predates it —
	 * or a test host — still satisfies the interface; the commands answer
	 * UNSUPPORTED when it is absent rather than throwing INTERNAL.
	 */
	agents?: AgentSessionsHost;

	/**
	 * Attention notifications (Feature 3). Optional for the same reason `agents`
	 * is: the commands answer UNSUPPORTED when the host predates the feature,
	 * rather than throwing INTERNAL out of a handler.
	 */
	notifications?: NotificationsHost;

	log(level: "info" | "warn" | "error", message: string): void;
}

export type AgentSessionStateName = "working" | "needsInput" | "idle" | "ended";

export interface AgentSessionSnapshot {
	surfaceId: string;
	workspaceId: string | null;
	agentKind: string;
	sessionId: string | null;
	transcriptPath: string | null;
	state: AgentSessionStateName;
	pid: number | null;
	lastActivityAt: number;
}

export interface HooksSetupResult {
	agent: string;
	settingsPath: string;
	changed: boolean;
	/** Set only when an existing file with different content was replaced. */
	backupPath: string | null;
	registered: string[];
	missing: string[];
}

export interface HooksStatusResult {
	agent: string;
	settingsPath: string;
	present: boolean;
	registered: string[];
	missing: string[];
}

export type NotificationKind = "attention" | "custom";

export interface NotificationSnapshot {
	id: string;
	kind: NotificationKind;
	title: string;
	body: string;
	paneId: string | null;
	workspaceId: string | null;
	createdAt: number;
	/** Null while unread. */
	readAt: number | null;
}

export interface NotificationsHost {
	/** Newest first. */
	list(options: { unreadOnly?: boolean }): NotificationSnapshot[];
	/** Returns null when the row could not be written. */
	create(input: {
		kind: NotificationKind;
		title: string;
		body: string;
		paneId: string | null;
		workspaceId: string | null;
	}): NotificationSnapshot | null;
	markRead(id: string): boolean;
	markAllRead(): number;
	/**
	 * Panes with at least one unread ATTENTION notification, newest ask first.
	 * The host does the kind filtering because "what counts as attention" is a
	 * property of the store, not of the command.
	 */
	panesWithUnreadAttention(): string[];
}

export interface AgentSessionsHost {
	listSessions(): AgentSessionSnapshot[];
	/**
	 * Feeds the SAME ingest path the HTTP hook receiver uses. Returns the
	 * transition, or null when the event did not change state.
	 */
	ingestEvent(input: {
		surfaceId: string;
		eventType: string;
		workspaceId?: string;
		sessionId?: string;
		transcriptPath?: string;
		agentKind?: string;
	}): { from: AgentSessionStateName; to: AgentSessionStateName } | null;
	/** Rewrites ADE's own hooks file. Throws UNSUPPORTED for non-claude agents. */
	setupHooks(agent: string): HooksSetupResult;
	hooksStatus(agent: string): HooksStatusResult;
}
