import { describe, expect, it } from "bun:test";
import { lastLines, stripAnsi } from "./terminal";

describe("stripAnsi", () => {
	it("removes SGR colour sequences", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("removes cursor-movement sequences", () => {
		expect(stripAnsi("a\x1b[2Ab")).toBe("ab");
	});

	it("removes an OSC title terminated by BEL", () => {
		expect(stripAnsi("\x1b]0;my title\x07text")).toBe("text");
	});

	it("removes an OSC terminated by ST", () => {
		expect(stripAnsi("\x1b]7;file:///tmp\x1b\\text")).toBe("text");
	});

	it("leaves plain text untouched", () => {
		expect(stripAnsi("plain — text")).toBe("plain — text");
	});

	it("drops a CR that only precedes a LF", () => {
		expect(stripAnsi("one\r\ntwo")).toBe("one\ntwo");
	});
});

describe("lastLines", () => {
	it("returns the final n lines", () => {
		expect(lastLines("a\nb\nc\nd", 2)).toBe("c\nd");
	});

	it("returns everything when asked for more lines than exist", () => {
		expect(lastLines("a\nb", 10)).toBe("a\nb");
	});

	it("ignores trailing blank lines when counting", () => {
		expect(lastLines("a\nb\nc\n\n\n", 2)).toBe("b\nc");
	});

	it("handles an empty buffer", () => {
		expect(lastLines("", 5)).toBe("");
	});
});
