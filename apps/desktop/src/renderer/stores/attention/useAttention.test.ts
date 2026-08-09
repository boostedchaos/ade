import { describe, expect, it } from "bun:test";
import { countAttentionForPanes } from "./useAttention";

/**
 * Pure-function test, following the tabs-store idiom: the hook itself is a
 * tRPC query and belongs to the live-smoke gate, but the arithmetic every tab
 * and rail badge depends on is testable here.
 */
describe("countAttentionForPanes", () => {
	it("sums only the panes it was given", () => {
		expect(countAttentionForPanes({ a: 2, b: 1, c: 5 }, ["a", "b"])).toBe(3);
	});

	it("is zero for panes with no unread rows", () => {
		expect(countAttentionForPanes({ a: 2 }, ["b", "c"])).toBe(0);
		expect(countAttentionForPanes({}, ["a"])).toBe(0);
	});

	it("accepts a Set, which is what the workspace rail passes", () => {
		expect(countAttentionForPanes({ a: 1, b: 3 }, new Set(["a", "b"]))).toBe(4);
	});
});
