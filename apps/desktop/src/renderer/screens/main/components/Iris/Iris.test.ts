import { describe, expect, it } from "bun:test";
import { PANE_STATUS_TO_IRIS } from "./Iris";

/**
 * These assert the CONTRACT between the app's PaneStatus union and the iris,
 * not a snapshot of today's mapping table.
 *
 * The point of the first test is that it fails when someone adds a fifth
 * PaneStatus and forgets the iris: `satisfies Record<PaneStatus, IrisState>`
 * already catches that at compile time, and this catches it at run time for
 * anyone reading test output rather than tsc output.
 */
describe("PANE_STATUS_TO_IRIS", () => {
	it("covers every PaneStatus the app can produce", () => {
		// Derived from the union's own members via the mapping's keys, so this
		// does not hardcode a count that would need hand-editing later.
		const covered = Object.keys(PANE_STATUS_TO_IRIS).sort();
		expect(covered).toEqual(["idle", "permission", "review", "working"]);
	});

	it("maps permission to waiting, not to its own name", () => {
		// SPEC.md §Rulings 1: the app calls it `permission`, the design calls it
		// "waiting on you". A rename on either side must not silently drop it to
		// idle.
		expect(PANE_STATUS_TO_IRIS.permission).toBe("waiting");
	});

	it("gives review its own state rather than folding it into idle", () => {
		// The brief defined four iris states and had none for `review`;
		// SPEC.md §Rulings 1 added a fifth. Folding it back into idle would make
		// a finished agent indistinguishable from one that never ran.
		expect(PANE_STATUS_TO_IRIS.review).toBe("review");
		expect(PANE_STATUS_TO_IRIS.review).not.toBe(PANE_STATUS_TO_IRIS.idle);
	});

	it("keeps working and waiting visually distinct", () => {
		expect(PANE_STATUS_TO_IRIS.working).toBe("working");
		expect(PANE_STATUS_TO_IRIS.working).not.toBe(
			PANE_STATUS_TO_IRIS.permission,
		);
	});
});
