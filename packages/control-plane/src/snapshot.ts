/**
 * The read model the control plane resolves targets against.
 *
 * PHASE 1 FINDING (recon §"Top 3" item 3, verified at HEAD): every field here
 * is already available IN THE MAIN PROCESS, so no read command and no target
 * resolution needs a renderer round trip.
 *   - panes / tabs / activeTabIds / focusedPaneIds
 *       `appState.data.tabsState` — the lowdb mirror the renderer's zustand
 *       `persist` middleware writes through `uiState.tabs.set` on every store
 *       change. Already read this way by main/lib/notifications/server.ts.
 *   - tabLayouts
 *       The persisted `layout` MosaicNode on each tab. Present at RUNTIME but
 *       absent from the `BaseTab` TypeScript type in shared/tabs-types.ts,
 *       which is why it is carried separately here instead of on the tab.
 *   - focusedWorkspaceId
 *       Parsed from the window URL (hash routing) — the app has no other
 *       notion of "current workspace"; main already does exactly this via
 *       extractWorkspaceIdFromUrl in main/windows/main.ts.
 *   - workspaceOrder
 *       getWorkspacesInVisualOrder(), which reads local-db directly.
 *
 * Freshness caveat, stated because a stale read is indistinguishable from a
 * fresh one: the mirror lags the renderer by one IPC round trip, so a target
 * resolved microseconds after a layout mutation may reflect the pre-mutation
 * order. Refs are documented as position-at-resolution-time anyway.
 */

export interface SnapshotPane {
	id: string;
	tabId: string;
	type: string;
	name: string;
	userTitle?: string;
	status?: string;
	cwd?: string | null;
	url?: string;
}

export interface SnapshotTab {
	id: string;
	name: string;
	userTitle?: string;
	workspaceId: string;
	createdAt: number;
}

export interface ControlPlaneSnapshot {
	panes: Record<string, SnapshotPane>;
	tabs: SnapshotTab[];
	/** workspaceId → tabId */
	activeTabIds: Record<string, string | null>;
	/** tabId → paneId */
	focusedPaneIds: Record<string, string>;
	/** tabId → react-mosaic layout tree (leaves are paneIds) */
	tabLayouts: Record<string, unknown>;
	focusedWorkspaceId: string | null;
	/** Workspace ids in the rail's visual order. */
	workspaceOrder: string[];
}

/**
 * Depth-first left/top-first walk of a react-mosaic tree, yielding pane ids in
 * the order they appear on screen. This is what makes `pane:<n>` mean what a
 * human reading the screen would expect.
 */
export function paneIdsInLayoutOrder(layout: unknown): string[] {
	const out: string[] = [];
	const walk = (node: unknown): void => {
		if (typeof node === "string") {
			out.push(node);
			return;
		}
		if (!node || typeof node !== "object") return;
		const branch = node as { first?: unknown; second?: unknown };
		if (branch.first !== undefined) walk(branch.first);
		if (branch.second !== undefined) walk(branch.second);
	};
	walk(layout);
	return out;
}

/**
 * Panes of a tab in screen order. Falls back to insertion order of the panes
 * record when the tab has no layout recorded (possible for a tab written by an
 * older app version), so a missing layout degrades to a defined order rather
 * than an empty list.
 */
export function panesForTabInOrder(
	snapshot: ControlPlaneSnapshot,
	tabId: string,
): SnapshotPane[] {
	const inTab = Object.values(snapshot.panes).filter((p) => p.tabId === tabId);
	const layoutOrder = paneIdsInLayoutOrder(snapshot.tabLayouts[tabId]);
	if (layoutOrder.length === 0) return inTab;

	const byId = new Map(inTab.map((p) => [p.id, p]));
	const ordered: SnapshotPane[] = [];
	for (const id of layoutOrder) {
		const pane = byId.get(id);
		if (pane) {
			ordered.push(pane);
			byId.delete(id);
		}
	}
	// Anything in the tab but absent from the layout still gets listed.
	for (const pane of byId.values()) ordered.push(pane);
	return ordered;
}

/** Tabs of a workspace in tab-strip order (the tabs array order). */
export function tabsForWorkspace(
	snapshot: ControlPlaneSnapshot,
	workspaceId: string,
): SnapshotTab[] {
	return snapshot.tabs.filter((t) => t.workspaceId === workspaceId);
}

/** The tab the user is looking at, or null when nothing is resolvable. */
export function focusedTabId(snapshot: ControlPlaneSnapshot): string | null {
	const workspaceId = snapshot.focusedWorkspaceId;
	if (!workspaceId) return null;
	const tabId = snapshot.activeTabIds[workspaceId];
	if (!tabId) return null;
	return snapshot.tabs.some((t) => t.id === tabId) ? tabId : null;
}

/**
 * Look up a pane that resolution has already proved exists. Present so callers
 * do not litter non-null assertions: under noUncheckedIndexedAccess every
 * record read is `T | undefined`, and swallowing that with `!` is how a stale
 * id turns into a crash instead of a NOT_FOUND.
 */
export function requirePane(
	snapshot: ControlPlaneSnapshot,
	paneId: string,
): SnapshotPane {
	const pane = snapshot.panes[paneId];
	if (!pane) {
		throw new Error(`Pane ${paneId} vanished between resolution and use`);
	}
	return pane;
}

/** The pane the user is looking at, or null. */
export function focusedPaneId(snapshot: ControlPlaneSnapshot): string | null {
	const tabId = focusedTabId(snapshot);
	if (!tabId) return null;
	const paneId = snapshot.focusedPaneIds[tabId];
	if (!paneId) return null;
	return snapshot.panes[paneId] ? paneId : null;
}
