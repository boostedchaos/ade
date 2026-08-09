/**
 * `HeadlessEmulator.getRenderedText` — the read that makes an alt-screen TUI
 * legible.
 *
 * Why this matters: the serialized ANSI snapshot reproduces a screen, it does
 * not describe one. Reading it means stripping escapes, and for a full-screen
 * TUI (Claude Code's own interface, vim, htop) what is left is redraw traffic
 * in arrival order — cursor jumps flattened away, text in the wrong places.
 * Reading the composed buffer instead gives what a human sees. These tests
 * pin that difference down, because it is the entire reason the daemon grew a
 * snapshot request.
 */

import { describe, expect, test } from "bun:test";

if (typeof window === "undefined") {
	(globalThis as Record<string, unknown>).window = globalThis;
}

const { HeadlessEmulator } = await import("./headless-emulator");

const ESC = "\x1b";
const CSI = `${ESC}[`;
const ENTER_ALT_SCREEN = `${CSI}?1049h`;
const LEAVE_ALT_SCREEN = `${CSI}?1049l`;

async function emulatorWith(
	data: string,
	options: { cols?: number; rows?: number; scrollback?: number } = {},
) {
	const emulator = new HeadlessEmulator({
		cols: options.cols ?? 80,
		rows: options.rows ?? 10,
		scrollback: options.scrollback ?? 1000,
	});
	emulator.write(data);
	await emulator.flush();
	return emulator;
}

describe("getRenderedText — basics", () => {
	test("returns the lines that were written", async () => {
		const emulator = await emulatorWith("alpha\r\nbeta\r\ngamma\r\n");
		expect(emulator.getRenderedText()).toEqual(["alpha", "beta", "gamma"]);
		emulator.dispose();
	});

	test("drops the blank padding rows below the content", async () => {
		// A 10-row viewport holding 2 lines must not return 8 empty strings.
		const emulator = await emulatorWith("one\r\ntwo\r\n", { rows: 10 });
		expect(emulator.getRenderedText()).toEqual(["one", "two"]);
		emulator.dispose();
	});

	test("returns nothing for an untouched terminal", async () => {
		const emulator = await emulatorWith("");
		expect(emulator.getRenderedText()).toEqual([]);
		emulator.dispose();
	});

	test("strips the escape sequences rather than reproducing them", async () => {
		const emulator = await emulatorWith(`${CSI}31mred text${CSI}0m\r\n`);
		const lines = emulator.getRenderedText();
		expect(lines).toEqual(["red text"]);
		expect(lines.join("")).not.toContain(ESC);
		emulator.dispose();
	});

	test("shows the COMPOSED result of an in-place overwrite", async () => {
		// Write a line, return to column 1, overwrite it. The output stream
		// contains both strings; the screen contains only the second.
		const emulator = await emulatorWith(`first\r${CSI}Ksecond\r\n`);
		const lines = emulator.getRenderedText();
		expect(lines).toEqual(["second"]);
		expect(lines.join("")).not.toContain("first");
		emulator.dispose();
	});
});

describe("getRenderedText — scrollback", () => {
	test("returns only the viewport by default", async () => {
		const rows = 5;
		const data = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join(
			"\r\n",
		);
		const emulator = await emulatorWith(`${data}\r\n`, { rows });
		const visible = emulator.getRenderedText();
		expect(visible.length).toBeLessThanOrEqual(rows);
		expect(visible).toContain("line20");
		expect(visible).not.toContain("line1");
		emulator.dispose();
	});

	test("reaches above the viewport when asked", async () => {
		const data = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join(
			"\r\n",
		);
		const emulator = await emulatorWith(`${data}\r\n`, { rows: 5 });
		const all = emulator.getRenderedText({ includeScrollback: true });
		expect(all).toContain("line1");
		expect(all).toContain("line20");
		emulator.dispose();
	});

	test("maxLines keeps the END of the output", async () => {
		const data = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join(
			"\r\n",
		);
		const emulator = await emulatorWith(`${data}\r\n`, { rows: 5 });
		const capped = emulator.getRenderedText({
			includeScrollback: true,
			maxLines: 3,
		});
		expect(capped).toEqual(["line18", "line19", "line20"]);
		emulator.dispose();
	});

	test("maxLines larger than the content returns everything", async () => {
		const emulator = await emulatorWith("a\r\nb\r\n", { rows: 10 });
		expect(
			emulator.getRenderedText({ includeScrollback: true, maxLines: 100 }),
		).toEqual(["a", "b"]);
		emulator.dispose();
	});
});

describe("getRenderedText — alternate screen (the flagship case)", () => {
	test("reports the alternate screen", async () => {
		const emulator = await emulatorWith(`${ENTER_ALT_SCREEN}TUI CONTENT\r\n`);
		expect(emulator.isAlternateScreen()).toBe(true);
		emulator.dispose();
	});

	test("returns what the TUI drew, not the traffic that drew it", async () => {
		// A TUI that paints, clears, and repaints: the stream contains both
		// frames, the screen contains only the second.
		const emulator = await emulatorWith(
			`${ENTER_ALT_SCREEN}${CSI}2J${CSI}HFRAME ONE` +
				`${CSI}2J${CSI}HFRAME TWO\r\n`,
		);
		const lines = emulator.getRenderedText();
		expect(lines.join("\n")).toContain("FRAME TWO");
		expect(lines.join("\n")).not.toContain("FRAME ONE");
		emulator.dispose();
	});

	test("ignores includeScrollback on the alt screen, which has none", async () => {
		const emulator = await emulatorWith(
			`scrollback line\r\n${ENTER_ALT_SCREEN}${CSI}2J${CSI}HALT CONTENT\r\n`,
		);
		const asked = emulator.getRenderedText({ includeScrollback: true });
		expect(asked.join("\n")).toContain("ALT CONTENT");
		// The normal buffer's history is not reachable while on the alt screen.
		expect(asked.join("\n")).not.toContain("scrollback line");
		emulator.dispose();
	});

	test("returns to the normal buffer's content after the TUI exits", async () => {
		const emulator = await emulatorWith(
			`before tui\r\n${ENTER_ALT_SCREEN}${CSI}2J${CSI}Halt stuff` +
				`${LEAVE_ALT_SCREEN}`,
		);
		expect(emulator.isAlternateScreen()).toBe(false);
		const lines = emulator.getRenderedText({ includeScrollback: true });
		expect(lines.join("\n")).toContain("before tui");
		expect(lines.join("\n")).not.toContain("alt stuff");
		emulator.dispose();
	});
});

describe("getRenderedText — read-only", () => {
	test("does not change dimensions", async () => {
		const emulator = await emulatorWith("content\r\n", { cols: 100, rows: 30 });
		const before = emulator.getDimensions();
		emulator.getRenderedText({ includeScrollback: true, maxLines: 2 });
		emulator.getRenderedText();
		expect(emulator.getDimensions()).toEqual(before);
		emulator.dispose();
	});

	test("repeated reads return the same thing", async () => {
		const emulator = await emulatorWith("stable\r\n");
		const first = emulator.getRenderedText();
		const second = emulator.getRenderedText();
		const third = emulator.getRenderedText({ includeScrollback: true });
		expect(second).toEqual(first);
		expect(third).toEqual(first);
		emulator.dispose();
	});

	test("does not disturb the serialized snapshot", async () => {
		const emulator = await emulatorWith("snapshot me\r\n");
		const before = emulator.getSnapshot().snapshotAnsi;
		emulator.getRenderedText({ includeScrollback: true });
		expect(emulator.getSnapshot().snapshotAnsi).toBe(before);
		emulator.dispose();
	});
});
