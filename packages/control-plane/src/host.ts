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
	};

	log(level: "info" | "warn" | "error", message: string): void;
}
