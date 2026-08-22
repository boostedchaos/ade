import type { MosaicBranch, MosaicNode } from "react-mosaic-component";
import type { ChangeCategory, FileStatus } from "shared/changes-types";
import type {
	AcpPaneOptions,
	BaseTab,
	BaseTabsState,
	BrowserLoadError,
	FileViewerMode,
	Pane,
	PaneStatus,
	PaneType,
	ViewportPreset,
} from "shared/tabs-types";

// Re-export shared types
export type { Pane, PaneStatus, PaneType };

/**
 * Snapshot of a closed tab + its panes, used for "reopen closed tab".
 */
export interface ClosedTabEntry {
	tab: Tab;
	panes: Pane[];
	closedAt: number;
}

/**
 * A Tab is a container that holds one or more Panes in a Mosaic layout.
 * Extends BaseTab with renderer-specific layout field.
 */
export interface Tab extends BaseTab {
	layout: MosaicNode<string>; // Always defined, leaves are paneIds
}

/**
 * State for the tabs/panes store.
 * Extends BaseTabsState with renderer-specific Tab type.
 */
export interface TabsState extends Omit<BaseTabsState, "tabs"> {
	tabs: Tab[];
	closedTabsStack: ClosedTabEntry[];
}

/**
 * Options for creating a tab with preset configuration
 */
export interface AddTabOptions {
	initialCwd?: string;
}

export interface AddTabWithMultiplePanesOptions {
	commands: string[];
	initialCwd?: string;
}

/**
 * Options for `splitPaneWithType` — creating a non-terminal pane as a split of
 * an existing one.
 *
 * `orientation` is mosaic's own vocabulary (row = side by side, column =
 * stacked) rather than left/right/up/down, because the store has no notion of
 * "left": the new pane always goes in `second`, and the caller swaps branches
 * to get the other side. Encoding four directions here would imply the store
 * can do something it cannot.
 */
export interface SplitPaneWithTypeOptions {
	paneType: Exclude<PaneType, "terminal">;
	orientation: "row" | "column";
	/** Mosaic path of the SOURCE pane. Empty/omitted splits at the root. */
	path?: MosaicBranch[];
	/** Required for `browser`; ignored otherwise. Defaults to about:blank. */
	url?: string;
	/** Required for `file-viewer`; the action returns null without it. */
	filePath?: string;
	/**
	 * Required for `acp` unless the source pane already carries one; the action
	 * returns null without it. This is the agent's worktree, and also the ACP
	 * filesystem sandbox root.
	 */
	cwd?: string;
}

/**
 * Options for opening a file in a file-viewer pane
 */
export interface AddFileViewerPaneOptions {
	filePath: string;
	/** Absolute path for out-of-worktree files (e.g. agent memory files) */
	absolutePath?: string;
	/** Override default view mode (raw/diff/rendered) */
	viewMode?: FileViewerMode;
	diffCategory?: ChangeCategory;
	/** File status from git — used to determine default view mode for new files */
	fileStatus?: FileStatus;
	commitHash?: string;
	oldPath?: string;
	/** Line to scroll to (raw mode only) */
	line?: number;
	/** Column to scroll to (raw mode only) */
	column?: number;
	/** If true, opens pinned (permanent). If false/undefined, opens in preview mode (can be replaced) */
	isPinned?: boolean;
	/** If true, opens in a new tab instead of splitting the current tab */
	openInNewTab?: boolean;
}

/**
 * Actions available on the tabs store
 */
export interface TabsStore extends TabsState {
	// Tab operations
	addTab: (
		workspaceId: string,
		options?: AddTabOptions,
	) => { tabId: string; paneId: string };
	addTabWithMultiplePanes: (
		workspaceId: string,
		options: AddTabWithMultiplePanesOptions,
	) => { tabId: string; paneIds: string[] };
	removeTab: (tabId: string) => void;
	renameTab: (tabId: string, newName: string) => void;
	setTabAutoTitle: (tabId: string, title: string) => void;
	setActiveTab: (workspaceId: string, tabId: string) => void;
	reorderTabs: (
		workspaceId: string,
		startIndex: number,
		endIndex: number,
	) => void;
	reorderTabById: (tabId: string, targetIndex: number) => void;
	updateTabLayout: (tabId: string, layout: MosaicNode<string>) => void;

	// Pane operations
	addPane: (tabId: string, options?: AddTabOptions) => string;
	addPanesToTab: (
		tabId: string,
		options: AddTabWithMultiplePanesOptions,
	) => string[];
	addFileViewerPane: (
		workspaceId: string,
		options: AddFileViewerPaneOptions,
	) => string;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
	markPaneAsUsed: (paneId: string) => void;
	setPaneStatus: (paneId: string, status: PaneStatus) => void;
	/**
	 * Record the ACP-minted session id on an `"acp"` pane. Persisted for Phase
	 * 6's resume; Phase 2 writes it and never reads it back. No-op for a pane
	 * that is not an ACP pane.
	 */
	setAcpSessionId: (paneId: string, acpSessionId: string) => void;
	setPaneName: (paneId: string, name: string) => void;
	/** Set the user-chosen pane title (via cmd+I rename). Pass undefined or empty
	 * string to clear and fall back to the auto name. */
	setPaneUserTitle: (paneId: string, userTitle: string | undefined) => void;
	setPaneTerminalProfile: (
		paneId: string,
		profileId: string | undefined,
	) => void;
	clearWorkspaceAttentionStatus: (workspaceId: string) => void;
	resetWorkspaceStatus: (workspaceId: string) => void;
	updatePaneCwd: (
		paneId: string,
		cwd: string | null,
		confirmed: boolean,
	) => void;
	clearPaneInitialData: (paneId: string) => void;
	/** Pin a file-viewer pane so it won't be replaced by new file clicks */
	pinPane: (paneId: string) => void;

	// Split operations
	splitPaneVertical: (
		tabId: string,
		sourcePaneId: string,
		path?: MosaicBranch[],
		options?: AddTabOptions,
	) => void;
	splitPaneHorizontal: (
		tabId: string,
		sourcePaneId: string,
		path?: MosaicBranch[],
		options?: AddTabOptions,
	) => void;
	splitPaneAuto: (
		tabId: string,
		sourcePaneId: string,
		dimensions: { width: number; height: number },
		path?: MosaicBranch[],
		options?: AddTabOptions,
	) => void;
	/**
	 * Split a pane and place a NON-terminal pane in the new half. Returns the
	 * new pane's id, or null when the source pane/tab is gone or the options are
	 * incomplete (a file-viewer with no path). The terminal splits hardcode
	 * `createPane(…, "terminal")`, which is why this is a separate action rather
	 * than an option on them.
	 */
	splitPaneWithType: (
		tabId: string,
		sourcePaneId: string,
		options: SplitPaneWithTypeOptions,
	) => string | null;

	// Move operations
	movePaneToTab: (paneId: string, targetTabId: string) => void;
	movePaneToNewTab: (paneId: string) => string;

	// ACP (agent conversation) operations
	/**
	 * New tab holding one ACP pane rooted at `cwd` (the agent's worktree).
	 *
	 * `options` carries what the flip would otherwise drop: the conversation to
	 * reopen (A8) and the agent's own name for the tab (A9).
	 */
	addAcpTab: (
		workspaceId: string,
		cwd: string,
		options?: AcpPaneOptions,
	) => { tabId: string; paneId: string };

	// Browser operations
	addBrowserTab: (
		workspaceId: string,
		url?: string,
	) => { tabId: string; paneId: string };
	openInBrowserPane: (workspaceId: string, url: string) => void;
	updateBrowserUrl: (
		paneId: string,
		url: string,
		title: string,
		faviconUrl?: string,
	) => void;
	navigateBrowserHistory: (
		paneId: string,
		direction: "back" | "forward",
	) => string | null;
	updateBrowserLoading: (paneId: string, isLoading: boolean) => void;
	setBrowserError: (paneId: string, error: BrowserLoadError | null) => void;
	setBrowserViewport: (paneId: string, viewport: ViewportPreset | null) => void;
	openDevToolsPane: (
		tabId: string,
		browserPaneId: string,
		path?: MosaicBranch[],
	) => string | null;

	// Reopen operations
	/** Reopen the last closed tab for a workspace. Returns true if a tab was reopened. */
	reopenClosedTab: (workspaceId: string) => boolean;

	// Query helpers
	getTabsByWorkspace: (workspaceId: string) => Tab[];
	getActiveTab: (workspaceId: string) => Tab | null;
	getPanesForTab: (tabId: string) => Pane[];
	getFocusedPane: (tabId: string) => Pane | null;
}
