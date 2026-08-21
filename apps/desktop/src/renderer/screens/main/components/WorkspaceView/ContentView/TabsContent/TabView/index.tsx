import "react-mosaic-component/react-mosaic-component.css";
import "./mosaic-theme.css";

import { useCallback, useEffect, useMemo } from "react";
import {
	Mosaic,
	type MosaicBranch,
	type MosaicNode,
} from "react-mosaic-component";
import { dragDropManager } from "renderer/lib/dnd";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Tab } from "renderer/stores/tabs/types";
import { useTabsWithPresets } from "renderer/stores/tabs/useTabsWithPresets";
import {
	cleanLayout,
	extractPaneIdsFromLayout,
} from "renderer/stores/tabs/utils";
import { useTheme } from "renderer/stores/theme";
import type { PaneType } from "shared/tabs-types";
import { AcpPane } from "./AcpPane";
import { BrowserPane } from "./BrowserPane";
import { DevToolsPane } from "./DevToolsPane";
import { FileViewerPane } from "./FileViewerPane";
import { TabPane } from "./TabPane";

interface TabViewProps {
	tab: Tab;
}

export function TabView({ tab }: TabViewProps) {
	const activeTheme = useTheme();
	const updateTabLayout = useTabsStore((s) => s.updateTabLayout);
	const removePane = useTabsStore((s) => s.removePane);
	const removeTab = useTabsStore((s) => s.removeTab);
	const { splitPaneAuto, splitPaneHorizontal, splitPaneVertical } =
		useTabsWithPresets();
	const setFocusedPane = useTabsStore((s) => s.setFocusedPane);
	const movePaneToTab = useTabsStore((s) => s.movePaneToTab);
	const movePaneToNewTab = useTabsStore((s) => s.movePaneToNewTab);
	const allTabs = useTabsStore((s) => s.tabs);
	const allPanes = useTabsStore((s) => s.panes);

	// Get workspace path for file viewer panes
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: tab.workspaceId },
		{ enabled: !!tab.workspaceId },
	);
	const worktreePath = workspace?.worktreePath ?? "";

	// Get tabs in the same workspace for move targets
	const workspaceTabs = useMemo(
		() => allTabs.filter((t) => t.workspaceId === tab.workspaceId),
		[allTabs, tab.workspaceId],
	);

	// Extract pane IDs from layout
	const layoutPaneIds = useMemo(
		() => extractPaneIdsFromLayout(tab.layout),
		[tab.layout],
	);

	// Memoize the filtered panes to avoid creating new objects on every render
	const tabPanes = useMemo(() => {
		const result: Record<
			string,
			{
				tabId: string;
				// The real union, not `string`: the exhaustiveness check in
				// `renderPane` is only a check if the discriminant is narrowable.
				type: PaneType;
				devtools?: { targetPaneId: string };
				acp?: { cwd: string };
			}
		> = {};
		for (const paneId of layoutPaneIds) {
			const pane = allPanes[paneId];
			if (pane?.tabId === tab.id) {
				result[paneId] = {
					tabId: pane.tabId,
					type: pane.type,
					devtools: pane.devtools,
					acp: pane.acp,
				};
			}
		}
		return result;
	}, [layoutPaneIds, allPanes, tab.id]);

	const validPaneIds = new Set(Object.keys(tabPanes));
	const cleanedLayout = cleanLayout(tab.layout, validPaneIds);

	// Auto-remove tab when all panes are gone
	useEffect(() => {
		if (!cleanedLayout) {
			removeTab(tab.id);
		}
	}, [cleanedLayout, removeTab, tab.id]);

	const handleLayoutChange = useCallback(
		(newLayout: MosaicNode<string> | null) => {
			if (!newLayout) {
				// This shouldn't happen as we handle last pane removal in removePane
				return;
			}

			// Get fresh data from store to avoid stale closure issues
			// This is critical for drag-drop operations where state may have changed
			// between when this callback was created and when it's invoked
			const state = useTabsStore.getState();
			const freshTab = state.tabs.find((t) => t.id === tab.id);
			const freshPanes = state.panes;

			// Use fresh tab layout to determine what panes were removed
			const oldPaneIds = extractPaneIdsFromLayout(
				freshTab?.layout ?? newLayout,
			);
			const newPaneIds = extractPaneIdsFromLayout(newLayout);

			// Find removed panes (e.g., from Mosaic close button)
			const removedPaneIds = oldPaneIds.filter(
				(id) => !newPaneIds.includes(id),
			);

			// Remove panes that were removed via Mosaic UI
			// But skip panes that were moved to another tab (their tabId changed)
			for (const removedId of removedPaneIds) {
				const pane = freshPanes[removedId];
				// Only remove if pane still belongs to this tab (actual removal, not move)
				if (pane && pane.tabId === tab.id) {
					removePane(removedId);
				}
			}

			updateTabLayout(tab.id, newLayout);
		},
		[tab.id, updateTabLayout, removePane],
	);

	const renderPane = useCallback(
		(paneId: string, path: MosaicBranch[]) => {
			const paneInfo = tabPanes[paneId];

			if (!paneInfo) {
				return (
					<div className="w-full h-full flex items-center justify-center text-muted-foreground">
						Pane not found: {paneId}
					</div>
				);
			}

			// Route file-viewer panes to FileViewerPane component
			if (paneInfo.type === "file-viewer") {
				if (!worktreePath) {
					return (
						<div className="w-full h-full flex items-center justify-center text-muted-foreground">
							Agent path unavailable
						</div>
					);
				}
				return (
					<FileViewerPane
						paneId={paneId}
						path={path}
						tabId={tab.id}
						worktreePath={worktreePath}
						splitPaneAuto={splitPaneAuto}
						splitPaneHorizontal={splitPaneHorizontal}
						splitPaneVertical={splitPaneVertical}
						removePane={removePane}
						setFocusedPane={setFocusedPane}
						availableTabs={workspaceTabs}
						onMoveToTab={(targetTabId) => movePaneToTab(paneId, targetTabId)}
						onMoveToNewTab={() => movePaneToNewTab(paneId)}
					/>
				);
			}

			// Route browser panes to BrowserPane component
			if (paneInfo.type === "webview") {
				return (
					<BrowserPane
						paneId={paneId}
						path={path}
						tabId={tab.id}
						splitPaneAuto={splitPaneAuto}
						removePane={removePane}
						setFocusedPane={setFocusedPane}
					/>
				);
			}

			// Route devtools panes
			if (paneInfo.type === "devtools") {
				if (!paneInfo.devtools) {
					// Narrowing on the sub-state used to live in the branch
					// CONDITION, which quietly sent a devtools pane with missing
					// state to the terminal fallback — and defeated the
					// exhaustiveness check, since `"devtools"` stayed in the union.
					return (
						<div className="flex h-full w-full items-center justify-center text-muted-foreground text-xs">
							DevTools pane has no target
						</div>
					);
				}
				return (
					<DevToolsPane
						paneId={paneId}
						path={path}
						tabId={tab.id}
						targetPaneId={paneInfo.devtools.targetPaneId}
						splitPaneAuto={splitPaneAuto}
						removePane={removePane}
						setFocusedPane={setFocusedPane}
					/>
				);
			}

			// Route ACP (agent conversation) panes
			if (paneInfo.type === "acp") {
				if (!paneInfo.acp?.cwd) {
					// The cwd IS the session's sandbox root. Rendering a session in
					// the wrong directory is worse than rendering this.
					return (
						<div className="flex h-full w-full items-center justify-center text-muted-foreground text-xs">
							ACP pane has no workspace directory
						</div>
					);
				}
				return (
					<AcpPane
						paneId={paneId}
						path={path}
						tabId={tab.id}
						cwd={paneInfo.acp.cwd}
						splitPaneAuto={splitPaneAuto}
						removePane={removePane}
						setFocusedPane={setFocusedPane}
					/>
				);
			}

			// Terminal panes — an EXPLICIT branch, not the fallback it used to be.
			if (paneInfo.type === "terminal") {
				return (
					<TabPane
						paneId={paneId}
						path={path}
						tabId={tab.id}
						workspaceId={tab.workspaceId}
						splitPaneAuto={splitPaneAuto}
						splitPaneHorizontal={splitPaneHorizontal}
						splitPaneVertical={splitPaneVertical}
						removePane={removePane}
						setFocusedPane={setFocusedPane}
						availableTabs={workspaceTabs}
						onMoveToTab={(targetTabId) => movePaneToTab(paneId, targetTabId)}
						onMoveToNewTab={() => movePaneToNewTab(paneId)}
					/>
				);
			}

			/**
			 * Two independent guards against the silent-terminal-fallback trap.
			 *
			 * The `never` assignment is a BUILD failure: add a member to
			 * `PaneType` and forget its renderer, and typecheck says so. The
			 * placeholder is a RUNTIME failure that is visible: stale persisted
			 * state, or a type added behind a cast, renders a named error rather
			 * than silently spawning a terminal in the agent's worktree.
			 */
			const exhaustive: never = paneInfo.type;
			console.error(
				`[TabView] Unknown pane type "${String(exhaustive)}" for pane ${paneId}`,
			);
			return (
				<div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground text-xs">
					<div>Unknown pane type: {String(exhaustive)}</div>
					<div className="opacity-70">{paneId}</div>
				</div>
			);
		},
		[
			tabPanes,
			tab.id,
			tab.workspaceId,
			worktreePath,
			splitPaneAuto,
			splitPaneHorizontal,
			splitPaneVertical,
			removePane,
			setFocusedPane,
			workspaceTabs,
			movePaneToTab,
			movePaneToNewTab,
		],
	);

	// Tab will be removed by useEffect above
	if (!cleanedLayout) {
		return null;
	}

	return (
		<div className="w-full h-full mosaic-container">
			<Mosaic<string>
				renderTile={renderPane}
				value={cleanedLayout}
				onChange={handleLayoutChange}
				className={
					activeTheme?.type === "light"
						? "mosaic-theme-light"
						: "mosaic-theme-dark"
				}
				dragAndDropManager={dragDropManager}
			/>
		</div>
	);
}
