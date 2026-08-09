import { describe, expect, it } from "bun:test";
import {
	asIncomingOp,
	type BridgeOp,
	BridgeOpError,
	findPaneMosaicPath,
	newPaneIds,
	paneIdsOf,
	planBridgeOp,
	planFocusRestore,
	swapBranchesAtPath,
} from "./control-plane-bridge";

/**
 * These exercise the PURE translation only — the repo's tabs tests test pure
 * functions rather than mounting the zustand store, and importing the store
 * here would pull in posthog and the tRPC client.
 */

const baseNewPane = {
	kind: "new-pane" as const,
	paneType: "terminal" as const,
	sourcePaneId: "p1",
	tabId: "t1",
	workspaceId: "ws1",
	focus: true,
};

/**
 * A three-pane layout. `p1` is nested two levels down inside `first`, so a
 * split of it must NOT touch the `p3` subtree — that is the regression these
 * cover.
 *
 *        row
 *       /   \
 *   column   p3
 *   /    \
 *  p1     p2
 */
const NESTED_LAYOUT = {
	direction: "row",
	first: { direction: "column", first: "p1", second: "p2" },
	second: "p3",
};

describe("findPaneMosaicPath", () => {
	it("returns an empty path when the pane IS the whole layout", () => {
		expect(findPaneMosaicPath("p1", "p1")).toEqual([]);
	});

	it("finds a pane nested two levels down", () => {
		expect(findPaneMosaicPath(NESTED_LAYOUT, "p1")).toEqual(["first", "first"]);
		expect(findPaneMosaicPath(NESTED_LAYOUT, "p2")).toEqual([
			"first",
			"second",
		]);
	});

	it("finds a pane that is a direct child of the root", () => {
		expect(findPaneMosaicPath(NESTED_LAYOUT, "p3")).toEqual(["second"]);
	});

	it("returns null for a pane that is not in the tree", () => {
		expect(findPaneMosaicPath(NESTED_LAYOUT, "ghost")).toBeNull();
	});

	it("returns null for a missing layout rather than throwing", () => {
		expect(findPaneMosaicPath(undefined, "p1")).toBeNull();
	});
});

describe("planBridgeOp — terminal splits", () => {
	it("maps right to a vertical split (mosaic row)", () => {
		expect(
			planBridgeOp({ ...baseNewPane, direction: "right" }, { layout: "p1" }),
		).toEqual([
			{
				action: "splitPaneVertical",
				tabId: "t1",
				sourcePaneId: "p1",
				path: [],
				initialCwd: undefined,
			},
		]);
	});

	it("maps down to a horizontal split (mosaic column)", () => {
		const plan = planBridgeOp(
			{ ...baseNewPane, direction: "down" },
			{ layout: "p1" },
		);
		expect(plan[0].action).toBe("splitPaneHorizontal");
	});

	it("splits at the ROOT when the source pane is the whole layout", () => {
		const plan = planBridgeOp(
			{ ...baseNewPane, direction: "right" },
			{ layout: "p1" },
		);
		expect(plan[0]).toMatchObject({ path: [] });
	});

	it("splits AT THE SOURCE PANE's node when that pane is nested", () => {
		// Regression: with no path the store splits at the root, putting the new
		// pane at the far edge of the tab instead of beside the named pane.
		const plan = planBridgeOp(
			{ ...baseNewPane, direction: "right" },
			{ layout: NESTED_LAYOUT },
		);
		expect(plan[0]).toMatchObject({
			action: "splitPaneVertical",
			sourcePaneId: "p1",
			path: ["first", "first"],
		});
	});

	/**
	 * REPLACES a test that asserted the opposite ("falls back to a root split
	 * when the pane is absent from the layout"). That fallback was the bug: a
	 * `--source-pane` naming a pane in some OTHER tab, or one closed between the
	 * CLI call and the dispatch, planned a split at the root of the target tab
	 * and returned success — so the caller was told its pane went beside `ghost`
	 * while it actually went to the far edge of a tab. Worse for left/up, where
	 * the follow-up `swapBranchesAtPath` at `[]` then reordered the whole tree.
	 */
	it("rejects a source pane that is absent from the layout", () => {
		expect(() =>
			planBridgeOp(
				{ ...baseNewPane, sourcePaneId: "ghost", direction: "right" },
				{ layout: NESTED_LAYOUT },
			),
		).toThrow(BridgeOpError);
	});

	it("reports NOT_FOUND, not BAD_REQUEST, for an absent source pane", () => {
		try {
			planBridgeOp(
				{ ...baseNewPane, sourcePaneId: "ghost", direction: "left" },
				{ layout: NESTED_LAYOUT },
			);
			throw new Error("expected planBridgeOp to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(BridgeOpError);
			expect((err as BridgeOpError).code).toBe("NOT_FOUND");
		}
	});

	/**
	 * The other half of the same distinction: `[]` is still a legitimate answer
	 * when the pane IS the root leaf, so the NOT_FOUND check above must not
	 * simply reject every empty path.
	 */
	it("still plans a root-path split when the pane IS the whole layout", () => {
		const plan = planBridgeOp(
			{ ...baseNewPane, direction: "right" },
			{ layout: "p1" },
		);
		expect(plan[0]).toMatchObject({ path: [] });
	});

	it("plans no store calls at all for an absent pane (no partial apply)", () => {
		// The swap step reads the store; planning must fail BEFORE anything is
		// queued, so a bad `--source-pane` can never half-apply.
		let plan: unknown;
		try {
			plan = planBridgeOp(
				{ ...baseNewPane, sourcePaneId: "ghost", direction: "up" },
				{ layout: NESTED_LAYOUT },
			);
		} catch {
			plan = undefined;
		}
		expect(plan).toBeUndefined();
	});

	it("swaps at the ROOT path for left when the source is the whole layout", () => {
		const plan = planBridgeOp(
			{ ...baseNewPane, direction: "left" },
			{ layout: "p1" },
		);
		expect(plan).toEqual([
			{
				action: "splitPaneVertical",
				tabId: "t1",
				sourcePaneId: "p1",
				path: [],
				initialCwd: undefined,
			},
			{ action: "swapBranchesAtPath", tabId: "t1", path: [] },
		]);
	});

	it("swaps at the SOURCE PANE's path for left when nested", () => {
		const plan = planBridgeOp(
			{ ...baseNewPane, direction: "left" },
			{ layout: NESTED_LAYOUT },
		);
		expect(plan.map((c) => c.action)).toEqual([
			"splitPaneVertical",
			"swapBranchesAtPath",
		]);
		// Both calls address the same node — the one the split creates.
		expect(plan[0]).toMatchObject({ path: ["first", "first"] });
		expect(plan[1]).toMatchObject({ path: ["first", "first"] });
	});

	it("swaps at the source pane's path for up when nested", () => {
		const plan = planBridgeOp(
			{ ...baseNewPane, sourcePaneId: "p2", direction: "up" },
			{ layout: NESTED_LAYOUT },
		);
		expect(plan.map((c) => c.action)).toEqual([
			"splitPaneHorizontal",
			"swapBranchesAtPath",
		]);
		expect(plan[1]).toMatchObject({ path: ["first", "second"] });
	});

	it("adds no swap for right or down", () => {
		for (const direction of ["right", "down"] as const) {
			const plan = planBridgeOp(
				{ ...baseNewPane, direction },
				{ layout: NESTED_LAYOUT },
			);
			expect(plan.map((c) => c.action)).toEqual([
				direction === "right" ? "splitPaneVertical" : "splitPaneHorizontal",
			]);
		}
	});

	it("passes cwd through as initialCwd", () => {
		const plan = planBridgeOp(
			{ ...baseNewPane, direction: "right", cwd: "/tmp/x" },
			{ layout: "p1" },
		);
		expect(plan[0]).toMatchObject({ initialCwd: "/tmp/x" });
	});

	it("refuses --command on a split rather than dropping it", () => {
		expect(() =>
			planBridgeOp(
				{ ...baseNewPane, direction: "right", command: "npm test" },
				{ layout: "p1" },
			),
		).toThrow(BridgeOpError);
	});
});

describe("new-split uses the same path-targeted plan", () => {
	it("targets the nested source pane's node", () => {
		const plan = planBridgeOp(
			{
				kind: "new-split",
				sourcePaneId: "p2",
				tabId: "t1",
				direction: "right",
				focus: true,
			},
			{ layout: NESTED_LAYOUT },
		);
		expect(plan).toEqual([
			{
				action: "splitPaneVertical",
				tabId: "t1",
				sourcePaneId: "p2",
				path: ["first", "second"],
				initialCwd: undefined,
			},
		]);
	});
});

describe("planBridgeOp — non-terminal pane types", () => {
	/**
	 * THE FLAGSHIP EXAMPLE, verbatim from SPEC.md and from the bundled
	 * ade-workspace skill:
	 *
	 *   ade new-pane --type browser --direction right --url … --focus false
	 *
	 * Through Phase 4 this planned `addBrowserTab` — a new TAB, not a split —
	 * because no store action could put a browser beside a named pane. Phase 5
	 * added `splitPaneWithType`, so the documented divergence is closed and this
	 * test is what keeps it closed.
	 */
	it("splits a browser pane in beside the source pane", () => {
		const plan = planBridgeOp(
			{
				...baseNewPane,
				paneType: "browser",
				direction: "right",
				url: "https://example.com",
				focus: false,
			},
			// `p1` IS the whole layout, so the plan's `path: []` means "the root
			// leaf" — not the old "pane not found, split at the root anyway".
			{ layout: "p1", sourcePaneType: "webview" },
		);
		expect(plan).toEqual([
			{
				action: "splitPaneWithType",
				tabId: "t1",
				sourcePaneId: "p1",
				path: [],
				paneType: "webview",
				orientation: "row",
				url: "https://example.com",
			},
		]);
	});

	/**
	 * `--focus false` is NOT part of the plan: every split action focuses its new
	 * pane, and the restore happens in runBridgeOp after the plan runs. Asserted
	 * here so a future "add a focus flag to the store action" change has to
	 * confront the fact that there is one implementation of not-stealing-focus.
	 */
	it("leaves focus handling out of the plan entirely", () => {
		const context = { layout: "p1", sourcePaneType: "webview" };
		const focused = planBridgeOp(
			{
				...baseNewPane,
				paneType: "browser",
				direction: "right",
				url: "https://example.com",
				focus: true,
			},
			context,
		);
		const unfocused = planBridgeOp(
			{
				...baseNewPane,
				paneType: "browser",
				direction: "right",
				url: "https://example.com",
				focus: false,
			},
			context,
		);
		expect(unfocused).toEqual(focused);
	});

	it("splits at the SOURCE pane's own node when it is nested", () => {
		const plan = planBridgeOp(
			{
				...baseNewPane,
				sourcePaneId: "p2",
				paneType: "browser",
				direction: "right",
				url: "https://example.com",
			},
			{ layout: NESTED_LAYOUT },
		);
		expect(plan[0]).toMatchObject({
			action: "splitPaneWithType",
			sourcePaneId: "p2",
			path: ["first", "second"],
		});
	});

	it("swaps branches at the SAME path for left/up", () => {
		const plan = planBridgeOp(
			{
				...baseNewPane,
				sourcePaneId: "p2",
				paneType: "browser",
				direction: "left",
				url: "https://example.com",
			},
			{ layout: NESTED_LAYOUT },
		);
		expect(plan).toEqual([
			{
				action: "splitPaneWithType",
				tabId: "t1",
				sourcePaneId: "p2",
				path: ["first", "second"],
				paneType: "webview",
				orientation: "row",
				url: "https://example.com",
			},
			{ action: "swapBranchesAtPath", tabId: "t1", path: ["first", "second"] },
		]);
	});

	it("uses a column split for up/down", () => {
		const plan = planBridgeOp(
			{
				...baseNewPane,
				paneType: "browser",
				direction: "down",
				url: "https://example.com",
			},
			{ layout: "p1", sourcePaneType: "webview" },
		);
		expect(plan[0]).toMatchObject({ orientation: "column" });
	});

	it("requires a url for a browser pane", () => {
		expect(() =>
			planBridgeOp({ ...baseNewPane, paneType: "browser", direction: "right" }),
		).toThrow(BridgeOpError);
	});

	it("splits a file-viewer pane in at the source pane", () => {
		const plan = planBridgeOp(
			{
				...baseNewPane,
				paneType: "file-viewer",
				direction: "right",
				path: "src/index.ts",
			},
			{ layout: "p1" },
		);
		expect(plan).toEqual([
			{
				action: "splitPaneWithType",
				tabId: "t1",
				sourcePaneId: "p1",
				path: [],
				paneType: "file-viewer",
				orientation: "row",
				filePath: "src/index.ts",
			},
		]);
	});

	it("requires a path for a file-viewer pane", () => {
		expect(() =>
			planBridgeOp({
				...baseNewPane,
				paneType: "file-viewer",
				direction: "right",
			}),
		).toThrow(BridgeOpError);
	});

	it("targets the source pane as the devtools inspection target", () => {
		const plan = planBridgeOp(
			{
				...baseNewPane,
				paneType: "devtools",
				direction: "right",
			},
			{ layout: "p1", sourcePaneType: "webview" },
		);
		expect(plan).toEqual([
			{
				action: "splitPaneWithType",
				tabId: "t1",
				sourcePaneId: "p1",
				path: [],
				paneType: "devtools",
				orientation: "row",
			},
		]);
	});

	/**
	 * `DevToolsPane` resolves its frontend URL by asking the CDP debug server
	 * for the target pane's page, and retries every second until it gets one.
	 * Against a terminal that never resolves, so before this check the command
	 * returned success and left a pane reading "Connecting to DevTools…"
	 * forever — a failure with no error anywhere to find it by.
	 */
	it("refuses devtools against a terminal source pane", () => {
		try {
			planBridgeOp(
				{ ...baseNewPane, paneType: "devtools", direction: "right" },
				{ layout: "p1", sourcePaneType: "terminal" },
			);
			throw new Error("expected planBridgeOp to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(BridgeOpError);
			expect((err as BridgeOpError).code).toBe("BAD_REQUEST");
		}
	});

	it("refuses devtools against a file-viewer source pane", () => {
		expect(() =>
			planBridgeOp(
				{ ...baseNewPane, paneType: "devtools", direction: "right" },
				{ layout: "p1", sourcePaneType: "file-viewer" },
			),
		).toThrow(BridgeOpError);
	});
});

describe("planBridgeOp — other ops", () => {
	it("split-off becomes movePaneToNewTab", () => {
		expect(planBridgeOp({ kind: "split-off", paneId: "p2" })).toEqual([
			{ action: "movePaneToNewTab", paneId: "p2" },
		]);
	});

	it("focus-pane activates the tab before focusing the pane", () => {
		const plan = planBridgeOp({
			kind: "focus-pane",
			paneId: "p2",
			tabId: "t1",
			workspaceId: "ws1",
		});
		expect(plan.map((c) => c.action)).toEqual([
			"setActiveTab",
			"setFocusedPane",
		]);
	});

	it("move-pane maps to movePaneToTab", () => {
		expect(
			planBridgeOp({ kind: "move-pane", paneId: "p2", targetTabId: "t9" }),
		).toEqual([{ action: "movePaneToTab", paneId: "p2", targetTabId: "t9" }]);
	});

	it("close-pane maps to removePane", () => {
		expect(planBridgeOp({ kind: "close-pane", paneId: "p2" })).toEqual([
			{ action: "removePane", paneId: "p2" },
		]);
	});

	it("new-tab without a command uses addTab", () => {
		const plan = planBridgeOp({
			kind: "new-tab",
			workspaceId: "ws1",
			focus: true,
		});
		expect(plan[0].action).toBe("addTab");
	});

	it("new-tab with a command uses addTabWithMultiplePanes", () => {
		const plan = planBridgeOp({
			kind: "new-tab",
			workspaceId: "ws1",
			command: "bun test",
			focus: true,
		});
		expect(plan).toEqual([
			{
				action: "addTabWithMultiplePanes",
				workspaceId: "ws1",
				commands: ["bun test"],
				initialCwd: undefined,
			},
		]);
	});

	it("focus-workspace is a router navigation, not a store write", () => {
		expect(
			planBridgeOp({ kind: "focus-workspace", workspaceId: "ws2" }),
		).toEqual([{ action: "navigateToWorkspace", workspaceId: "ws2" }]);
	});

	it("rejects an unrecognised op kind", () => {
		expect(() =>
			planBridgeOp({ kind: "nonsense" } as unknown as BridgeOp),
		).toThrow(BridgeOpError);
	});
});

describe("pane-id diffing", () => {
	it("finds ids added by an action", () => {
		const before = paneIdsOf({ a: 1, b: 2 });
		const after = paneIdsOf({ a: 1, b: 2, c: 3 });
		expect(newPaneIds(before, after)).toEqual(["c"]);
	});

	it("returns nothing when the set is unchanged", () => {
		const before = paneIdsOf({ a: 1 });
		expect(newPaneIds(before, paneIdsOf({ a: 1 }))).toEqual([]);
	});

	it("ignores removals", () => {
		const before = paneIdsOf({ a: 1, b: 2 });
		expect(newPaneIds(before, paneIdsOf({ a: 1 }))).toEqual([]);
	});
});

describe("swapBranchesAtPath", () => {
	it("swaps first and second at the root", () => {
		expect(
			swapBranchesAtPath({ direction: "row", first: "a", second: "b" }, []),
		).toEqual({ direction: "row", first: "b", second: "a" });
	});

	it("leaves a leaf layout alone", () => {
		expect(swapBranchesAtPath("only", [])).toBe("only");
	});

	it("preserves nested subtrees on the swapped sides", () => {
		const nested: Record<string, unknown> = {
			direction: "row",
			first: "a",
			second: { direction: "column", first: "b", second: "c" },
		};
		expect(swapBranchesAtPath(nested, [])).toEqual({
			direction: "row",
			first: { direction: "column", first: "b", second: "c" },
			second: "a",
		});
	});

	it("swaps ONLY the addressed node and leaves siblings untouched", () => {
		// The regression this whole fix is about: swapping a nested split must
		// not rearrange the unrelated `p3` subtree.
		const layoutAfterSplit = {
			direction: "row",
			first: {
				direction: "column",
				// the node the split just created, at path ["first","first"]
				first: { direction: "row", first: "p1", second: "pNew" },
				second: "p2",
			},
			second: { direction: "column", first: "p3", second: "p4" },
		};
		const result = swapBranchesAtPath(layoutAfterSplit, ["first", "first"]);
		expect(result).toEqual({
			direction: "row",
			first: {
				direction: "column",
				first: { direction: "row", first: "pNew", second: "p1" },
				second: "p2",
			},
			second: { direction: "column", first: "p3", second: "p4" },
		});
		// Unrelated subtree is not merely equal — it is the same object.
		expect((result as { second: unknown }).second).toBe(
			layoutAfterSplit.second,
		);
	});

	it("puts the new pane on the correct side and leaves the rest BYTE-IDENTICAL", () => {
		// The acceptance case for FIX 2, written as the reviewer specified it.
		// Layout below is a 4-pane tab AFTER a right-split of the nested `p1`;
		// `pNew` sits in `second` (the right side). A `--direction left` split
		// must move `pNew` to `first` of THAT node only.
		const unrelated = {
			direction: "column",
			first: "p3",
			second: { direction: "row", first: "p4", second: "p5" },
		};
		const layoutAfterSplit = {
			direction: "row",
			first: {
				direction: "column",
				first: { direction: "row", first: "p1", second: "pNew" },
				second: "p2",
			},
			second: unrelated,
		};
		const unrelatedBefore = JSON.stringify(unrelated);
		const wholeBefore = JSON.stringify(layoutAfterSplit);

		const result = swapBranchesAtPath(layoutAfterSplit, ["first", "first"]);

		// (1) the new pane ends up on the correct side of its OWN sibling
		const swappedNode = (
			result as { first: { first: { first: string; second: string } } }
		).first.first;
		expect(swappedNode.first).toBe("pNew");
		expect(swappedNode.second).toBe("p1");

		// (2) unrelated subtrees are byte-identical before and after
		expect(JSON.stringify((result as { second: unknown }).second)).toBe(
			unrelatedBefore,
		);
		// …and the input was not mutated in place.
		expect(JSON.stringify(layoutAfterSplit)).toBe(wholeBefore);
		// Structural sharing: the untouched subtree is the very same object.
		expect((result as { second: unknown }).second).toBe(unrelated);
		// The sibling `p2` alongside the swapped node is also untouched.
		expect((result as { first: { second: string } }).first.second).toBe("p2");
	});

	it("preserves splitPercentage and other node fields", () => {
		expect(
			swapBranchesAtPath(
				{ direction: "row", first: "a", second: "b", splitPercentage: 30 },
				[],
			),
		).toEqual({
			direction: "row",
			first: "b",
			second: "a",
			splitPercentage: 30,
		});
	});

	it("returns the layout unchanged for a path that addresses nothing", () => {
		const layout = { direction: "row", first: "a", second: "b" };
		expect(swapBranchesAtPath(layout, ["first", "second"])).toBe(layout);
	});

	it("returns the layout unchanged when the addressed node is a leaf", () => {
		const layout = { direction: "row", first: "a", second: "b" };
		expect(swapBranchesAtPath(layout, ["first"])).toBe(layout);
	});
});

describe("asIncomingOp", () => {
	/**
	 * The IPC listener signature is `(...args: unknown[])` — the preload cannot
	 * type a channel's payload — so this guard is the only thing standing
	 * between a main-process message and `planBridgeOp`. It used to be a cast
	 * plus a `typeof opId === "string"` check, which let a payload with no `op`
	 * at all through to be destructured.
	 */
	it("accepts a well-formed payload", () => {
		expect(
			asIncomingOp({ opId: "op-1", op: { kind: "close-pane", paneId: "p2" } }),
		).toEqual({ opId: "op-1", op: { kind: "close-pane", paneId: "p2" } });
	});

	it("rejects a payload with no op", () => {
		expect(asIncomingOp({ opId: "op-1" })).toBeNull();
	});

	it("rejects an op with no kind", () => {
		expect(asIncomingOp({ opId: "op-1", op: { paneId: "p2" } })).toBeNull();
	});

	it("rejects a missing, empty or non-string opId", () => {
		expect(asIncomingOp({ op: { kind: "close-pane" } })).toBeNull();
		expect(asIncomingOp({ opId: "", op: { kind: "close-pane" } })).toBeNull();
		expect(asIncomingOp({ opId: 7, op: { kind: "close-pane" } })).toBeNull();
	});

	it("rejects non-object payloads", () => {
		expect(asIncomingOp(undefined)).toBeNull();
		expect(asIncomingOp(null)).toBeNull();
		expect(asIncomingOp("op-1")).toBeNull();
	});
});

describe("planFocusRestore", () => {
	const splitContext = {
		createdPaneTabId: "t1",
		sourcePaneExists: true,
		priorWorkspaceId: "ws1",
		priorActiveTabId: "t1",
		priorFocusedPaneId: "p1",
	};

	it("restores the source pane after an unfocused split", () => {
		expect(
			planFocusRestore(
				{ ...baseNewPane, direction: "right", focus: false },
				splitContext,
			),
		).toEqual({ kind: "pane", tabId: "t1", paneId: "p1" });
	});

	it("does nothing when focus was requested", () => {
		expect(
			planFocusRestore(
				{ ...baseNewPane, direction: "right", focus: true },
				splitContext,
			),
		).toBeNull();
	});

	it("does nothing when the op created no pane", () => {
		expect(
			planFocusRestore(
				{ ...baseNewPane, direction: "right", focus: false },
				{ ...splitContext, createdPaneTabId: undefined },
			),
		).toBeNull();
	});

	/**
	 * CANARY for finding 4. Against the previous implementation this case
	 * returned nothing at all: the restore path tested `op.kind === "new-pane"
	 * || op.kind === "new-split"` and `new-tab` fell off the end, so
	 * `ade new-tab --focus false` (and tmux `new-window -d`, which maps onto
	 * it) left the caller sitting in the tab it had just created. Asserting a
	 * "tab" restore is what fails against that code — a focused-pane assertion
	 * would not, because `addTab` does not move the focused pane of the tab you
	 * came from.
	 */
	it("restores the PRIOR ACTIVE TAB after an unfocused new-tab", () => {
		expect(
			planFocusRestore(
				{ kind: "new-tab", workspaceId: "ws1", focus: false },
				{
					createdPaneTabId: "t2",
					sourcePaneExists: false,
					priorWorkspaceId: "ws1",
					priorActiveTabId: "t1",
					priorFocusedPaneId: "p1",
				},
			),
		).toEqual({ kind: "tab", workspaceId: "ws1", tabId: "t1", paneId: "p1" });
	});

	it("restores the tab even when its focused pane is gone", () => {
		expect(
			planFocusRestore(
				{ kind: "new-tab", workspaceId: "ws1", focus: false },
				{
					createdPaneTabId: "t2",
					sourcePaneExists: false,
					priorWorkspaceId: "ws1",
					priorActiveTabId: "t1",
					priorFocusedPaneId: undefined,
				},
			),
		).toEqual({
			kind: "tab",
			workspaceId: "ws1",
			tabId: "t1",
			paneId: undefined,
		});
	});

	it("does nothing for an unfocused new-tab with no prior active tab", () => {
		// First tab in an empty workspace: there is nothing to go back to, and
		// activating the new one is the only sensible outcome.
		expect(
			planFocusRestore(
				{ kind: "new-tab", workspaceId: "ws1", focus: false },
				{
					createdPaneTabId: "t2",
					sourcePaneExists: false,
					priorWorkspaceId: "ws1",
					priorActiveTabId: undefined,
				},
			),
		).toBeNull();
	});

	it("does nothing when the source pane of a split has gone", () => {
		expect(
			planFocusRestore(
				{ ...baseNewPane, direction: "right", focus: false },
				{ ...splitContext, sourcePaneExists: false },
			),
		).toBeNull();
	});
});
