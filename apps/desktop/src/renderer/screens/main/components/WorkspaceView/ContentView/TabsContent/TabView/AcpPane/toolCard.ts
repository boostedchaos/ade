/**
 * The tool card's non-visual logic, kept out of the component so it is
 * testable without a DOM.
 *
 * Only `planDiff` lives here so far: what a diff block actually renders is a
 * decision about the wire's data (is this a new file? how much of it may we
 * put on screen?), not about markup.
 */

/**
 * How many lines of one diff side reach the DOM.
 *
 * A `Write` of a 5,000-line file arrives as one diff block, and the card
 * re-renders on every streaming chunk of the turn that produced it — so the
 * cap is a rendering budget, not a display preference. 200 lines is well past
 * what anyone reads in a collapsed card and two orders of magnitude off the
 * pathological case.
 */
export const DIFF_LINE_CAP = 200;

export interface DiffSide {
	/** The lines to render, already capped. */
	lines: string[];
	/** Lines the cap withheld; 0 when the whole side is shown. */
	hidden: number;
}

export interface DiffPlan {
	/** Null for a new file — the SDK sends `oldText: null` to say exactly that. */
	removed: DiffSide | null;
	added: DiffSide;
}

function capSide(text: string, cap: number): DiffSide {
	const lines = text.split("\n");
	if (lines.length <= cap) return { lines, hidden: 0 };
	return { lines: lines.slice(0, cap), hidden: lines.length - cap };
}

/**
 * What a `{type:"diff"}` content block should put on screen.
 *
 * `oldText == null` means the file did not exist, so there is nothing to show
 * as removed — rendering `"".split("\n")` there produces one phantom red line
 * on every new file. The cap applies per side: the sides are separate blocks
 * and a huge one is huge on its own.
 */
export function planDiff(
	oldText: string | null | undefined,
	newText: string,
	cap: number = DIFF_LINE_CAP,
): DiffPlan {
	return {
		removed: oldText == null ? null : capSide(oldText, cap),
		added: capSide(newText, cap),
	};
}

/** `1 more line` / `12 more lines`, for the tail row under a capped side. */
export function hiddenLinesLabel(hidden: number): string {
	return `${hidden.toLocaleString()} more line${hidden === 1 ? "" : "s"}`;
}
