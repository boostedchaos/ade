import { describe, expect, it } from "bun:test";
import { ControlError } from "./protocol";
import type { ControlPlaneSnapshot } from "./snapshot";
import { paneIdsInLayoutOrder, panesForTabInOrder } from "./snapshot";
import { resolveTarget } from "./target-resolution";

/**
 * A two-workspace / three-tab / four-pane fixture. Tab "t1" has a mosaic
 * layout so pane ordering is exercised against the real tree shape rather
 * than the insertion order of the panes record — the two deliberately differ.
 */
function makeSnapshot(
	overrides: Partial<ControlPlaneSnapshot> = {},
): ControlPlaneSnapshot {
	return {
		panes: {
			// Insertion order p3, p1, p2 — layout order is p1, p2, p3.
			p3: { id: "p3", tabId: "t1", type: "terminal", name: "three" },
			p1: { id: "p1", tabId: "t1", type: "terminal", name: "one" },
			p2: { id: "p2", tabId: "t1", type: "webview", name: "two" },
			p9: { id: "p9", tabId: "t2", type: "terminal", name: "nine" },
		},
		tabs: [
			{ id: "t1", name: "first", workspaceId: "ws1", createdAt: 1 },
			{ id: "t2", name: "second", workspaceId: "ws1", createdAt: 2 },
			{ id: "t3", name: "other", workspaceId: "ws2", createdAt: 3 },
		],
		activeTabIds: { ws1: "t1", ws2: "t3" },
		focusedPaneIds: { t1: "p2", t2: "p9" },
		tabLayouts: {
			t1: {
				direction: "row",
				first: { direction: "column", first: "p1", second: "p2" },
				second: "p3",
			},
			t2: "p9",
		},
		focusedWorkspaceId: "ws1",
		workspaceOrder: ["ws1", "ws2"],
		...overrides,
	};
}

describe("paneIdsInLayoutOrder", () => {
	it("walks first-then-second depth first", () => {
		expect(paneIdsInLayoutOrder(makeSnapshot().tabLayouts.t1)).toEqual([
			"p1",
			"p2",
			"p3",
		]);
	});

	it("treats a bare string layout as a single pane", () => {
		expect(paneIdsInLayoutOrder("only")).toEqual(["only"]);
	});

	it("returns nothing for a missing layout", () => {
		expect(paneIdsInLayoutOrder(undefined)).toEqual([]);
	});
});

describe("panesForTabInOrder", () => {
	it("uses layout order, not the panes-record insertion order", () => {
		const snapshot = makeSnapshot();
		expect(panesForTabInOrder(snapshot, "t1").map((p) => p.id)).toEqual([
			"p1",
			"p2",
			"p3",
		]);
	});

	it("falls back to record order when the tab has no layout", () => {
		const snapshot = makeSnapshot({ tabLayouts: {} });
		expect(
			panesForTabInOrder(snapshot, "t1")
				.map((p) => p.id)
				.sort(),
		).toEqual(["p1", "p2", "p3"]);
	});

	it("still lists a pane that the layout tree omits", () => {
		const snapshot = makeSnapshot({ tabLayouts: { t1: "p1" } });
		expect(panesForTabInOrder(snapshot, "t1").map((p) => p.id)).toEqual([
			"p1",
			"p3",
			"p2",
		]);
	});
});

describe("resolveTarget — ids", () => {
	it("accepts an id that exists", () => {
		expect(resolveTarget(makeSnapshot(), "pane", "p2")).toBe("p2");
		expect(resolveTarget(makeSnapshot(), "tab", "t3")).toBe("t3");
		expect(resolveTarget(makeSnapshot(), "workspace", "ws2")).toBe("ws2");
	});

	it("rejects an id that does not exist with NOT_FOUND", () => {
		expect(() => resolveTarget(makeSnapshot(), "pane", "nope")).toThrow(
			ControlError,
		);
		try {
			resolveTarget(makeSnapshot(), "pane", "nope");
		} catch (error) {
			expect((error as ControlError).code).toBe("NOT_FOUND");
		}
	});

	it("rejects a non-string target with BAD_REQUEST", () => {
		try {
			resolveTarget(makeSnapshot(), "pane", 3);
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as ControlError).code).toBe("BAD_REQUEST");
		}
	});
});

describe("resolveTarget — focused", () => {
	it("resolves the focused pane through workspace → active tab → focused pane", () => {
		expect(resolveTarget(makeSnapshot(), "pane", "focused")).toBe("p2");
	});

	it("resolves the focused tab and workspace", () => {
		expect(resolveTarget(makeSnapshot(), "tab", "focused")).toBe("t1");
		expect(resolveTarget(makeSnapshot(), "workspace", "focused")).toBe("ws1");
	});

	it("is NOT_FOUND when no workspace is focused", () => {
		const snapshot = makeSnapshot({ focusedWorkspaceId: null });
		try {
			resolveTarget(snapshot, "pane", "focused");
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as ControlError).code).toBe("NOT_FOUND");
		}
	});

	it("is NOT_FOUND when the focused pane id is stale", () => {
		const snapshot = makeSnapshot({ focusedPaneIds: { t1: "ghost" } });
		try {
			resolveTarget(snapshot, "pane", "focused");
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as ControlError).code).toBe("NOT_FOUND");
		}
	});
});

describe("resolveTarget — refs", () => {
	it("counts panes 1-based in the focused tab's layout order", () => {
		const snapshot = makeSnapshot();
		expect(resolveTarget(snapshot, "pane", "pane:1")).toBe("p1");
		expect(resolveTarget(snapshot, "pane", "pane:2")).toBe("p2");
		expect(resolveTarget(snapshot, "pane", "pane:3")).toBe("p3");
	});

	it("counts tabs 1-based within the focused workspace only", () => {
		const snapshot = makeSnapshot();
		expect(resolveTarget(snapshot, "tab", "tab:1")).toBe("t1");
		expect(resolveTarget(snapshot, "tab", "tab:2")).toBe("t2");
		// t3 belongs to ws2, so it is not tab:3 while ws1 is focused.
		try {
			resolveTarget(snapshot, "tab", "tab:3");
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as ControlError).code).toBe("NOT_FOUND");
		}
	});

	it("counts workspaces 1-based in rail order", () => {
		expect(resolveTarget(makeSnapshot(), "workspace", "workspace:2")).toBe(
			"ws2",
		);
	});

	it("rejects position 0 as BAD_REQUEST, not NOT_FOUND", () => {
		try {
			resolveTarget(makeSnapshot(), "pane", "pane:0");
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as ControlError).code).toBe("BAD_REQUEST");
		}
	});

	it("rejects a ref of the wrong kind as BAD_REQUEST", () => {
		try {
			resolveTarget(makeSnapshot(), "pane", "workspace:1");
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as ControlError).code).toBe("BAD_REQUEST");
			expect((error as ControlError).message).toContain("workspace ref");
		}
	});

	it("is NOT_FOUND past the end of the list", () => {
		try {
			resolveTarget(makeSnapshot(), "pane", "pane:99");
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as ControlError).code).toBe("NOT_FOUND");
		}
	});
});
