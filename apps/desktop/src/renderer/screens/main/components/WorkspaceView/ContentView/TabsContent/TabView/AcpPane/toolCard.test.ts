/**
 * The tool card's diff planning — the two review findings that live in it.
 *
 * F5: a new file arrives as `oldText: null`, and `(oldText ?? "").split("\n")`
 * turns that into one phantom removed line on every new file.
 * F4: a diff side is rendered one node per line with no cap, so a 5,000-line
 * `Write` puts 5,000 nodes in the DOM and re-renders them on every chunk.
 */

import { describe, expect, it } from "bun:test";
import { DIFF_LINE_CAP, hiddenLinesLabel, planDiff } from "./toolCard";

describe("F5 — a new file has no removed side", () => {
	it("renders no removed block when oldText is null", () => {
		expect(planDiff(null, "line one\nline two").removed).toBeNull();
	});

	it("renders no removed block when oldText is absent", () => {
		expect(planDiff(undefined, "line one").removed).toBeNull();
	});

	it("still renders the added side of a new file", () => {
		expect(planDiff(null, "line one\nline two").added.lines).toEqual([
			"line one",
			"line two",
		]);
	});

	it("keeps a removed block for a real edit", () => {
		expect(planDiff("was", "is").removed?.lines).toEqual(["was"]);
	});

	it("keeps a removed block for a truncation to empty", () => {
		// An EMPTY string is not a missing one: the file existed and its whole
		// content was removed, which is a real red line.
		expect(planDiff("", "new").removed?.lines).toEqual([""]);
	});
});

describe("F4 — a diff side is capped", () => {
	const big = (count: number) =>
		Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

	it("caps the added side and reports what it withheld", () => {
		const { added } = planDiff(null, big(5000));
		expect(added.lines).toHaveLength(DIFF_LINE_CAP);
		expect(added.hidden).toBe(5000 - DIFF_LINE_CAP);
	});

	it("caps the removed side too", () => {
		const { removed } = planDiff(big(5000), "new");
		expect(removed?.lines).toHaveLength(DIFF_LINE_CAP);
		expect(removed?.hidden).toBe(5000 - DIFF_LINE_CAP);
	});

	it("shows a side that fits whole, and hides nothing", () => {
		const { added } = planDiff(null, big(DIFF_LINE_CAP));
		expect(added.lines).toHaveLength(DIFF_LINE_CAP);
		expect(added.hidden).toBe(0);
	});

	it("keeps the FIRST lines, not the last", () => {
		expect(planDiff(null, big(500), 3).added.lines).toEqual([
			"line 1",
			"line 2",
			"line 3",
		]);
	});

	it("labels the withheld lines, singular and plural", () => {
		expect(hiddenLinesLabel(1)).toBe("1 more line");
		expect(hiddenLinesLabel(4800)).toBe("4,800 more lines");
	});
});
