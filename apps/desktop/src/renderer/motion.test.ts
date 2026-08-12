import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The brief's motion rules are non-negotiable and none of them is expressible
 * as a component test — they are properties of the stylesheet. So this asserts
 * them against the CSS itself.
 *
 * It reads globals.css by a path derived from THIS file's location, so moving
 * either file breaks the test loudly instead of silently validating nothing.
 */
const GLOBALS_CSS = join(import.meta.dir, "globals.css");
const css = readFileSync(GLOBALS_CSS, "utf8");

describe("Argus motion rules", () => {
	it("reads a globals.css that actually contains the Argus motion block", () => {
		// Guard against the whole suite passing because it loaded an empty or
		// unrelated file: every assertion below is a NEGATIVE, and negatives on
		// an empty string all pass.
		expect(css.length).toBeGreaterThan(1000);
		expect(css).toContain("argus-attention-pulse");
		expect(css).toContain("argus-iris-wake");
		expect(css).toContain("argus-memory-write");
	});

	it("never loops the attention ring — exactly three pulses, then stop", () => {
		// The single most specific motion rule in the brief. `infinite` anywhere
		// in an Argus animation would turn a transient "answer me" into a
		// permanent throb.
		const argusAnimations = css
			.split("\n")
			.filter((line) => line.includes("animation:") && line.includes("argus-"));
		expect(argusAnimations.length).toBeGreaterThan(0);
		for (const line of argusAnimations) {
			expect(line).not.toContain("infinite");
		}
		expect(css).toContain("argus-attention-pulse var(--argus-duration-slow)");
		// The iteration count sits at the end of that shorthand.
		const pulseRule = css
			.split("\n")
			.find((line) => line.includes("argus-attention-pulse var("));
		expect(pulseRule).toBeDefined();
		expect(pulseRule).toMatch(/\b3\b/);
	});

	it("collapses every movement under prefers-reduced-motion", () => {
		expect(css).toContain("prefers-reduced-motion: reduce");
		const reducedBlocks = css.split("prefers-reduced-motion: reduce").slice(1);
		const combined = reducedBlocks.join("\n");
		// The four Argus movements plus the busy indicators the app still runs.
		for (const selector of [
			".argus-iris-pupil-wake",
			".argus-iris-attention-ring",
			".argus-memory-write",
			".animate-spin",
		]) {
			expect(combined).toContain(selector);
		}
	});

	it("uses only the three duration tokens for Argus movements", () => {
		for (const token of [
			"--argus-duration-fast: 120ms",
			"--argus-duration-base: 220ms",
			"--argus-duration-slow: 900ms",
		]) {
			expect(css).toContain(token);
		}
	});

	it("never animates a property that moves an element", () => {
		// "No element changes position — only color, opacity and radius."
		// A keyframe touching top/left/margin/width would reflow the terminal.
		const keyframeBlocks = css.split("@keyframes ").slice(1);
		const argusKeyframes = keyframeBlocks.filter((b) => b.startsWith("argus-"));
		expect(argusKeyframes.length).toBeGreaterThan(0);
		for (const block of argusKeyframes) {
			const body = block.slice(0, block.indexOf("\n\t}"));
			for (const forbidden of [
				"top:",
				"left:",
				"right:",
				"bottom:",
				"margin",
				"width:",
				"height:",
				"translate",
			]) {
				expect(body).not.toContain(forbidden);
			}
		}
	});
});
