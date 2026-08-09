/**
 * Renderer half of the control-plane bridge.
 *
 * Main serves every READ from its app-state mirror (see
 * packages/control-plane/src/snapshot.ts), so this file exists only for layout
 * MUTATIONS, which live in the renderer-owned zustand store.
 *
 * Shape: main sends `{opId, op}` on the `ade:control-plane:op` IPC channel;
 * this module translates the op into calls on the EXISTING store actions and
 * replies `{opId, result}` or `{opId, error}` on `ade:control-plane:result`.
 * Main parks the promise under opId with a 10 s timeout.
 *
 * The translation itself is a PURE function (`planBridgeOp`) returning a list
 * of store-action descriptors, following the repo's tabs-test idiom of testing
 * pure functions rather than mounting the store. `applyPlan` is the only
 * impure part and is a thin switch.
 */

import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useTabsStore } from "./store";

/**
 * Structural duplicate of `BridgeOp` in packages/control-plane/src/host.ts.
 * Kept duplicated on purpose: main must not import renderer code (it would
 * pull the store and zustand into the main bundle) and the renderer has no
 * workspace dependency edge to @ade/control-plane. Change one, change both.
 */
export type BridgeDirection = "left" | "right" | "up" | "down";

export type BridgeOp =
	| {
			kind: "new-pane";
			paneType: "terminal" | "browser" | "file-viewer" | "devtools";
			sourcePaneId: string;
			tabId: string;
			workspaceId: string;
			direction: BridgeDirection;
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
			direction: BridgeDirection;
			cwd?: string;
			focus: boolean;
	  }
	| { kind: "split-off"; paneId: string }
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
	| { kind: "create-workspace"; projectId: string; name?: string };

/**
 * A step down a react-mosaic tree. Mirrors the library's `MosaicBranch` so
 * this module stays testable without importing react-mosaic-component.
 */
export type MosaicBranch = "first" | "second";
export type MosaicPath = MosaicBranch[];

/** One call on an existing store action. */
export type StoreCall =
	| {
			action: "splitPaneVertical";
			tabId: string;
			sourcePaneId: string;
			/** Where in the mosaic tree the source pane lives. See splitCall(). */
			path: MosaicPath;
			initialCwd?: string;
	  }
	| {
			action: "splitPaneHorizontal";
			tabId: string;
			sourcePaneId: string;
			path: MosaicPath;
			initialCwd?: string;
	  }
	/**
	 * Swap the branches of ONE split node, via the existing `updateTabLayout`
	 * action. This is how `--direction left|up` is produced: the split actions
	 * always place the new pane in `second` (right/below) and no store action
	 * exposes the other side.
	 *
	 * `path` addresses the node the split just created — the SAME path the
	 * split was performed at — so a nested split swaps only its own two
	 * children and leaves every unrelated subtree alone.
	 */
	| { action: "swapBranchesAtPath"; tabId: string; path: MosaicPath }
	/**
	 * Split at `path` and put a non-terminal pane in the new half. `orientation`
	 * is mosaic's own (row = side by side); left/up is this call followed by
	 * `swapBranchesAtPath` at the SAME path, exactly as terminal splits do.
	 */
	| {
			action: "splitPaneWithType";
			tabId: string;
			sourcePaneId: string;
			path: MosaicPath;
			paneType: "webview" | "file-viewer" | "devtools";
			orientation: "row" | "column";
			url?: string;
			filePath?: string;
	  }
	| { action: "addBrowserTab"; workspaceId: string; url?: string }
	| {
			action: "addFileViewerPane";
			workspaceId: string;
			filePath: string;
			openInNewTab: boolean;
	  }
	| { action: "openDevToolsPane"; tabId: string; browserPaneId: string }
	| { action: "addTab"; workspaceId: string; initialCwd?: string }
	| {
			action: "addTabWithMultiplePanes";
			workspaceId: string;
			commands: string[];
			initialCwd?: string;
	  }
	| { action: "movePaneToTab"; paneId: string; targetTabId: string }
	| { action: "movePaneToNewTab"; paneId: string }
	| { action: "removePane"; paneId: string }
	| { action: "setFocusedPane"; tabId: string; paneId: string }
	| { action: "setActiveTab"; workspaceId: string; tabId: string }
	| { action: "navigateToWorkspace"; workspaceId: string }
	| { action: "createWorkspace"; projectId: string; name?: string };

export class BridgeOpError extends Error {
	constructor(
		readonly code: "BAD_REQUEST" | "UNSUPPORTED" | "NOT_FOUND",
		message: string,
	) {
		super(message);
		this.name = "BridgeOpError";
	}
}

/** Right/down put the new pane in mosaic's `second`; left/up need a swap. */
function needsSwap(direction: BridgeDirection): boolean {
	return direction === "left" || direction === "up";
}

/**
 * PURE. Path from the root of a mosaic tree to a pane's leaf, as the
 * first/second steps taken to reach it. `[]` means the pane IS the whole
 * layout. Returns null when the pane is not in the tree.
 */
export function findPaneMosaicPath(
	layout: unknown,
	paneId: string,
): MosaicPath | null {
	if (typeof layout === "string") {
		return layout === paneId ? [] : null;
	}
	if (!layout || typeof layout !== "object") return null;
	const node = layout as { first?: unknown; second?: unknown };

	// An empty array is a truthy hit meaning "this child IS the pane", so the
	// null check has to be explicit — `if (inFirst)` alone would be right by
	// accident and wrong the moment someone switches the sentinel.
	const inFirst = findPaneMosaicPath(node.first, paneId);
	if (inFirst !== null) return ["first", ...inFirst];

	const inSecond = findPaneMosaicPath(node.second, paneId);
	if (inSecond !== null) return ["second", ...inSecond];

	return null;
}

/**
 * PURE. Swap the two branches of the split node at `path`, leaving every
 * other node — including both swapped subtrees' contents — untouched.
 * Returns the input unchanged if the path does not address a split node.
 */
export function swapBranchesAtPath<T>(layout: T, path: MosaicPath): T {
	if (!layout || typeof layout !== "object") return layout;
	const node = layout as { first?: unknown; second?: unknown };

	if (path.length === 0) {
		if (node.first === undefined || node.second === undefined) return layout;
		return { ...node, first: node.second, second: node.first } as T;
	}

	const [step, ...rest] = path;
	if (step === undefined) return layout;
	const child = step === "first" ? node.first : node.second;
	if (child === undefined) return layout;
	const updated = swapBranchesAtPath(child, rest);
	if (updated === child) return layout;
	return { ...node, [step as string]: updated } as T;
}

/**
 * Build the split call.
 *
 * The `path` matters and its absence was a real bug: the store's split actions
 * only split AT the source pane when given a path — with `path` undefined they
 * take the `else` branch and build `{first: <entire existing layout>, second:
 * newPane}`, i.e. they split at the ROOT. Passing no path therefore put a new
 * pane at the far edge of the whole tab instead of beside the pane the caller
 * named, whenever that pane was nested. The UI never hit this because
 * react-mosaic hands each tile its own path (TabPane.tsx:163-164).
 */
function splitCall(
	direction: BridgeDirection,
	tabId: string,
	sourcePaneId: string,
	path: MosaicPath,
	initialCwd?: string,
): StoreCall {
	// Mosaic "row" is side-by-side, "column" is stacked.
	return direction === "left" || direction === "right"
		? { action: "splitPaneVertical", tabId, sourcePaneId, path, initialCwd }
		: { action: "splitPaneHorizontal", tabId, sourcePaneId, path, initialCwd };
}

/**
 * PURE. The source pane's path in the tab's layout, or NOT_FOUND.
 *
 * `[]` and "absent" are different answers that `findPaneMosaicPath` returns as
 * `[]` and `null`, and collapsing them with `?? []` was a real bug: a pane id
 * that is not in this tab at all became a split at the ROOT of the tab, so the
 * command reported success while putting the new pane somewhere the caller
 * never named — and then `swapBranchesAtPath` at `[]` rearranged the whole
 * tree on top of it. `[]` is only legitimate when the pane IS the root leaf.
 */
function requireSourcePath(
	layout: unknown,
	sourcePaneId: string,
	tabId: string,
): MosaicPath {
	const path = findPaneMosaicPath(layout, sourcePaneId);
	if (path === null) {
		throw new BridgeOpError(
			"NOT_FOUND",
			`Pane ${sourcePaneId} is not in tab ${tabId}`,
		);
	}
	return path;
}

/**
 * Split plan for a NON-terminal pane. Same two-step shape as `splitPlan`
 * below — split at the source pane's own node, then swap that node's branches
 * for left/up — so all four directions behave identically whatever the pane
 * type, and a nested split still leaves its siblings alone.
 */
function typedSplitPlan(
	direction: BridgeDirection,
	tabId: string,
	sourcePaneId: string,
	layout: unknown,
	paneType: "webview" | "file-viewer" | "devtools",
	extra: { url?: string; filePath?: string } = {},
): StoreCall[] {
	const path = requireSourcePath(layout, sourcePaneId, tabId);
	const calls: StoreCall[] = [
		{
			action: "splitPaneWithType",
			tabId,
			sourcePaneId,
			path,
			paneType,
			orientation:
				direction === "left" || direction === "right" ? "row" : "column",
			...extra,
		},
	];
	if (needsSwap(direction)) {
		calls.push({ action: "swapBranchesAtPath", tabId, path });
	}
	return calls;
}

/**
 * Split plan shared by `new-pane --type terminal` and `new-split`: split at
 * the source pane's own node, then, for left/up, swap that node's branches.
 * Both operations address the SAME path, which is what keeps a nested split
 * from disturbing its siblings.
 */
function splitPlan(
	direction: BridgeDirection,
	tabId: string,
	sourcePaneId: string,
	layout: unknown,
	initialCwd?: string,
): StoreCall[] {
	const path = requireSourcePath(layout, sourcePaneId, tabId);
	const calls: StoreCall[] = [
		splitCall(direction, tabId, sourcePaneId, path, initialCwd),
	];
	if (needsSwap(direction)) {
		calls.push({ action: "swapBranchesAtPath", tabId, path });
	}
	return calls;
}

/**
 * Everything about current state the plan depends on. Passed in rather than
 * read from the store so `planBridgeOp` stays a pure function — the repo's
 * tabs tests test pure functions rather than mounting zustand.
 */
export interface BridgePlanContext {
	/** Mosaic layout of the tab the op targets, when the op targets one. */
	layout?: unknown;
	/**
	 * `type` of the op's source pane, when it has one. Only `devtools` needs
	 * it — a DevTools pane inspects a webview through the CDP debug server, so
	 * against any other pane type it has nothing to attach to.
	 */
	sourcePaneType?: string;
}

/**
 * PURE. op → the sequence of existing store actions that performs it.
 * Throws BridgeOpError for combinations no existing store action can express,
 * rather than silently doing something adjacent.
 */
export function planBridgeOp(
	op: BridgeOp,
	context: BridgePlanContext = {},
): StoreCall[] {
	switch (op.kind) {
		case "new-pane": {
			switch (op.paneType) {
				case "terminal": {
					if (op.command) {
						throw new BridgeOpError(
							"UNSUPPORTED",
							"--command is not available when splitting a pane; the split store actions take no command. Use `new-tab --command` instead.",
						);
					}
					return splitPlan(
						op.direction,
						op.tabId,
						op.sourcePaneId,
						context.layout,
						op.cwd,
					);
				}
				case "browser": {
					if (!op.url) {
						throw new BridgeOpError(
							"BAD_REQUEST",
							"--url is required for a browser pane",
						);
					}
					// Phase-1 DIVERGENCE NOW CLOSED. This used to plan
					// `addBrowserTab`, opening a new tab instead of a split, because
					// the store's split actions hardcoded a terminal pane and no
					// action could put a browser beside a named pane. Phase 5 added
					// `splitPaneWithType`, so the spec's flagship example —
					// `--type browser --direction right --focus false` — now does
					// literally what it says.
					return typedSplitPlan(
						op.direction,
						op.tabId,
						op.sourcePaneId,
						context.layout,
						"webview",
						{ url: op.url },
					);
				}
				case "file-viewer": {
					if (!op.path) {
						throw new BridgeOpError(
							"BAD_REQUEST",
							"--path is required for a file-viewer pane",
						);
					}
					return typedSplitPlan(
						op.direction,
						op.tabId,
						op.sourcePaneId,
						context.layout,
						"file-viewer",
						{ filePath: op.path },
					);
				}
				case "devtools": {
					// DevTools targets the pane it is opened from, so the source pane
					// is both the split point and the inspected pane.
					//
					// It must be a webview. `DevToolsPane` resolves its frontend URL by
					// asking the CDP debug server for the target pane's page and polls
					// every second until it gets one — against a terminal that request
					// can never succeed, so the pane sat on "Connecting to DevTools…"
					// polling forever while the command reported success.
					if (
						context.sourcePaneType !== undefined &&
						context.sourcePaneType !== "webview"
					) {
						throw new BridgeOpError(
							"BAD_REQUEST",
							`DevTools can only inspect a browser pane; pane ${op.sourcePaneId} is a ${context.sourcePaneType} pane`,
						);
					}
					return typedSplitPlan(
						op.direction,
						op.tabId,
						op.sourcePaneId,
						context.layout,
						"devtools",
					);
				}
			}
			break;
		}

		case "new-split":
			return splitPlan(
				op.direction,
				op.tabId,
				op.sourcePaneId,
				context.layout,
				op.cwd,
			);

		case "split-off":
			return [{ action: "movePaneToNewTab", paneId: op.paneId }];

		case "focus-pane":
			return [
				{
					action: "setActiveTab",
					workspaceId: op.workspaceId,
					tabId: op.tabId,
				},
				{ action: "setFocusedPane", tabId: op.tabId, paneId: op.paneId },
			];

		case "move-pane":
			return [
				{
					action: "movePaneToTab",
					paneId: op.paneId,
					targetTabId: op.targetTabId,
				},
			];

		case "close-pane":
			return [{ action: "removePane", paneId: op.paneId }];

		case "new-tab":
			return op.command
				? [
						{
							action: "addTabWithMultiplePanes",
							workspaceId: op.workspaceId,
							commands: [op.command],
							initialCwd: op.cwd,
						},
					]
				: [
						{
							action: "addTab",
							workspaceId: op.workspaceId,
							initialCwd: op.cwd,
						},
					];

		case "focus-workspace":
			return [{ action: "navigateToWorkspace", workspaceId: op.workspaceId }];

		case "create-workspace":
			return [
				{
					action: "createWorkspace",
					projectId: op.projectId,
					name: op.name,
				},
			];
	}

	throw new BridgeOpError("BAD_REQUEST", "Unrecognised bridge op");
}

/** PURE. Pane ids present in a tabs-store-shaped panes record. */
export function paneIdsOf(panes: Record<string, unknown>): Set<string> {
	return new Set(Object.keys(panes));
}

/** PURE. Ids in `after` that were not in `before`, in insertion order. */
export function newPaneIds(before: Set<string>, after: Set<string>): string[] {
	return [...after].filter((id) => !before.has(id));
}

// Deliberately no root-only swap helper lives here. An exported
// `swapRootBranches(layout)` was the original bug: it rearranged the whole
// tree for a split that happened deep inside it. `swapBranchesAtPath` above
// is the only swap, and it requires a path, so the unscoped version cannot be
// reached for again by accident.

// ---------------------------------------------------------------------------
// Impure half: apply a plan against the live store.
// ---------------------------------------------------------------------------

type NavigateFn = (workspaceId: string) => void;

let navigate: NavigateFn | null = null;

/**
 * Workspace focus is a ROUTER navigation, not store state (the app derives the
 * current workspace from the URL). The renderer entry point supplies the
 * navigator; without it `focus-workspace` reports UNSUPPORTED rather than
 * silently doing nothing.
 */
export function setControlPlaneNavigator(fn: NavigateFn | null): void {
	navigate = fn;
}

async function applyPlan(plan: StoreCall[]): Promise<Record<string, unknown>> {
	const store = useTabsStore.getState();
	const extra: Record<string, unknown> = {};

	for (const call of plan) {
		switch (call.action) {
			case "splitPaneVertical":
				store.splitPaneVertical(
					call.tabId,
					call.sourcePaneId,
					call.path,
					call.initialCwd ? { initialCwd: call.initialCwd } : undefined,
				);
				break;
			case "splitPaneHorizontal":
				store.splitPaneHorizontal(
					call.tabId,
					call.sourcePaneId,
					call.path,
					call.initialCwd ? { initialCwd: call.initialCwd } : undefined,
				);
				break;
			case "swapBranchesAtPath": {
				// Re-read: the split above already mutated the store, and the node
				// we are swapping is the one it just created at this path.
				const tab = useTabsStore
					.getState()
					.tabs.find((t) => t.id === call.tabId);
				// Skipping silently would land a `--direction left|up` pane on the
				// right/below and still report success, which is the failure mode
				// the NOT_FOUND check in `requireSourcePath` exists to prevent.
				if (!tab) {
					throw new BridgeOpError(
						"NOT_FOUND",
						`Tab ${call.tabId} disappeared before the split could be oriented`,
					);
				}
				useTabsStore
					.getState()
					.updateTabLayout(
						call.tabId,
						swapBranchesAtPath(tab.layout, call.path),
					);
				break;
			}
			case "splitPaneWithType":
				store.splitPaneWithType(call.tabId, call.sourcePaneId, {
					paneType: call.paneType,
					orientation: call.orientation,
					path: call.path,
					url: call.url,
					filePath: call.filePath,
				});
				break;
			case "addBrowserTab":
				store.addBrowserTab(call.workspaceId, call.url);
				break;
			case "addFileViewerPane":
				store.addFileViewerPane(call.workspaceId, {
					filePath: call.filePath,
					openInNewTab: call.openInNewTab,
					isPinned: true,
				});
				break;
			case "openDevToolsPane":
				store.openDevToolsPane(call.tabId, call.browserPaneId);
				break;
			case "addTab":
				store.addTab(
					call.workspaceId,
					call.initialCwd ? { initialCwd: call.initialCwd } : undefined,
				);
				break;
			case "addTabWithMultiplePanes":
				store.addTabWithMultiplePanes(call.workspaceId, {
					commands: call.commands,
					initialCwd: call.initialCwd,
				});
				break;
			case "movePaneToTab":
				store.movePaneToTab(call.paneId, call.targetTabId);
				break;
			case "movePaneToNewTab":
				store.movePaneToNewTab(call.paneId);
				break;
			case "removePane":
				store.removePane(call.paneId);
				break;
			case "setFocusedPane":
				store.setFocusedPane(call.tabId, call.paneId);
				break;
			case "setActiveTab":
				store.setActiveTab(call.workspaceId, call.tabId);
				break;
			case "navigateToWorkspace":
				if (!navigate) {
					throw new BridgeOpError(
						"UNSUPPORTED",
						"No router navigator registered; cannot focus a workspace",
					);
				}
				navigate(call.workspaceId);
				break;
			case "createWorkspace": {
				// Reuses the app's only workspace-creation path rather than
				// re-implementing worktree setup in the control plane.
				const created = await electronTrpcClient.workspaces.create.mutate({
					projectId: call.projectId,
					name: call.name,
				});
				extra.workspaceId = (created as { id?: string })?.id ?? null;
				extra.workspace = created;
				break;
			}
		}
	}

	return extra;
}

export const CONTROL_PLANE_OP_CHANNEL = "ade:control-plane:op";
export const CONTROL_PLANE_RESULT_CHANNEL = "ade:control-plane:result";

interface IncomingOp {
	opId: string;
	op: BridgeOp;
}

/**
 * PURE. Runtime shape check for an IPC payload.
 *
 * The IPC listener signature is `(...args: unknown[])` — the preload cannot
 * know a channel's payload type — so the narrowing has to happen here, at the
 * boundary, rather than being asserted by a cast. A cheap shape check is
 * enough: `planBridgeOp` already rejects any op it does not recognise, so this
 * only has to establish that there is an opId to reply to and an op to plan.
 */
export function asIncomingOp(payload: unknown): IncomingOp | null {
	if (!payload || typeof payload !== "object") return null;
	const candidate = payload as { opId?: unknown; op?: unknown };
	if (typeof candidate.opId !== "string" || candidate.opId === "") return null;
	if (!candidate.op || typeof candidate.op !== "object") return null;
	if (typeof (candidate.op as { kind?: unknown }).kind !== "string")
		return null;
	return { opId: candidate.opId, op: candidate.op as BridgeOp };
}

/**
 * What `--focus false` has to undo, as a descriptor rather than a store call —
 * the repo's tabs tests test pure functions, and this decision is the whole of
 * finding 4.
 */
export type FocusRestore =
	| { kind: "pane"; tabId: string; paneId: string }
	| { kind: "tab"; workspaceId: string; tabId: string; paneId?: string }
	| null;

export interface FocusRestoreContext {
	/** Tab the newly created pane landed in; absent when nothing was created. */
	createdPaneTabId?: string;
	/** Whether the op's source pane is still in the store. */
	sourcePaneExists: boolean;
	priorWorkspaceId?: string;
	/** Previously active tab, ONLY if it still exists. */
	priorActiveTabId?: string;
	/** Pane focused in that tab, ONLY if it still exists. */
	priorFocusedPaneId?: string;
}

/**
 * PURE. `focus: false` → what to put back.
 *
 * Splits and new tabs steal focus DIFFERENTLY and this used to handle only the
 * first: a split moves the focused pane within its tab, but `addTab` ACTIVATES
 * the tab it creates. So `ade new-tab --focus false` — and tmux's
 * `new-window -d`, which maps onto it — yanked the user to a brand-new tab
 * while reporting that it had not taken focus. Restoring the focused pane
 * alone would not have fixed it; the active TAB is the thing that moved.
 */
export function planFocusRestore(
	op: BridgeOp,
	context: FocusRestoreContext,
): FocusRestore {
	if (!("focus" in op) || op.focus !== false) return null;
	if (!context.createdPaneTabId) return null;

	if (op.kind === "new-pane" || op.kind === "new-split") {
		if (!context.sourcePaneExists) return null;
		return {
			kind: "pane",
			tabId: context.createdPaneTabId,
			paneId: op.sourcePaneId,
		};
	}

	if (op.kind === "new-tab") {
		if (!context.priorWorkspaceId || !context.priorActiveTabId) return null;
		return {
			kind: "tab",
			workspaceId: context.priorWorkspaceId,
			tabId: context.priorActiveTabId,
			paneId: context.priorFocusedPaneId,
		};
	}

	return null;
}

/**
 * Run one op and produce the reply payload main is waiting for.
 * Exported for the entry point; not for external callers.
 */
export async function runBridgeOp(
	op: BridgeOp,
): Promise<Record<string, unknown>> {
	const before = paneIdsOf(useTabsStore.getState().panes);

	// Captured BEFORE the plan runs: `addTab` activates the tab it creates, so
	// honouring `--focus false` on `new-tab` (and on tmux's `new-window -d`)
	// means putting these two back afterwards. Read here because the plan is
	// what destroys them.
	const priorWorkspaceId = "workspaceId" in op ? op.workspaceId : undefined;
	const priorActiveTabId = priorWorkspaceId
		? useTabsStore.getState().activeTabIds[priorWorkspaceId]
		: undefined;
	const priorFocusedPaneId = priorActiveTabId
		? useTabsStore.getState().focusedPaneIds[priorActiveTabId]
		: undefined;

	// Split ops need the target tab's mosaic tree to locate the source pane.
	// Read here rather than inside the planner so the planner stays pure.
	const targetTabId = "tabId" in op ? op.tabId : undefined;
	const layout = targetTabId
		? useTabsStore.getState().tabs.find((t) => t.id === targetTabId)?.layout
		: undefined;

	const sourcePaneType =
		"sourcePaneId" in op
			? useTabsStore.getState().panes[op.sourcePaneId]?.type
			: undefined;

	const plan = planBridgeOp(op, { layout, sourcePaneType });
	const extra = await applyPlan(plan);
	const state = useTabsStore.getState();
	const created = newPaneIds(before, paneIdsOf(state.panes));

	const result: Record<string, unknown> = {
		applied: plan.map((c) => c.action),
		...extra,
	};
	if (created.length > 0) {
		result.paneId = created[created.length - 1];
		result.createdPaneIds = created;
		const createdPane = state.panes[created[created.length - 1]];
		if (createdPane) result.tabId = createdPane.tabId;
	}

	const restore = planFocusRestore(op, {
		createdPaneTabId:
			created.length > 0
				? state.panes[created[created.length - 1]]?.tabId
				: undefined,
		sourcePaneExists:
			"sourcePaneId" in op ? Boolean(state.panes[op.sourcePaneId]) : false,
		priorWorkspaceId,
		priorActiveTabId:
			priorActiveTabId && state.tabs.some((t) => t.id === priorActiveTabId)
				? priorActiveTabId
				: undefined,
		priorFocusedPaneId:
			priorFocusedPaneId && state.panes[priorFocusedPaneId]
				? priorFocusedPaneId
				: undefined,
	});

	if (restore?.kind === "pane") {
		useTabsStore.getState().setFocusedPane(restore.tabId, restore.paneId);
		result.focusRestoredTo = restore.paneId;
	} else if (restore?.kind === "tab") {
		useTabsStore.getState().setActiveTab(restore.workspaceId, restore.tabId);
		result.activeTabRestoredTo = restore.tabId;
		if (restore.paneId) {
			useTabsStore.getState().setFocusedPane(restore.tabId, restore.paneId);
			result.focusRestoredTo = restore.paneId;
		}
	}

	return result;
}

let registered = false;

/**
 * Wire the bridge to IPC. Idempotent; safe to call from the renderer entry
 * point on every HMR pass.
 */
export function registerControlPlaneBridge(): () => void {
	const ipc = window.ipcRenderer as typeof window.ipcRenderer | undefined;
	if (!ipc || registered) return () => {};
	registered = true;

	const handler = (...args: unknown[]): void => {
		const payload = args[0];
		const incoming = asIncomingOp(payload);
		if (!incoming) {
			// Reply if we can still name the op; main parks every send under an
			// opId and would otherwise wait out its 10 s timeout. With no usable
			// opId there is nothing to reply to, so drop it.
			const opId = (payload as { opId?: unknown } | null | undefined)?.opId;
			if (typeof opId === "string" && opId !== "") {
				ipc.send(CONTROL_PLANE_RESULT_CHANNEL, {
					opId,
					error: { code: "BAD_REQUEST", message: "Malformed bridge op" },
				});
			}
			return;
		}
		runBridgeOp(incoming.op)
			.then((result) => {
				ipc.send(CONTROL_PLANE_RESULT_CHANNEL, { opId: incoming.opId, result });
			})
			.catch((error: unknown) => {
				const code = error instanceof BridgeOpError ? error.code : "INTERNAL";
				const message =
					error instanceof Error ? error.message : "Bridge op failed";
				ipc.send(CONTROL_PLANE_RESULT_CHANNEL, {
					opId: incoming.opId,
					error: { code, message },
				});
			});
	};

	ipc.on(CONTROL_PLANE_OP_CHANNEL, handler);
	return () => {
		ipc.off(CONTROL_PLANE_OP_CHANNEL, handler);
		registered = false;
	};
}
