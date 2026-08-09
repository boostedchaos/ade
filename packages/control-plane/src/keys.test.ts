import { describe, expect, it } from "bun:test";
import { resolveKeySequence } from "./keys";
import { ControlError } from "./protocol";

describe("resolveKeySequence", () => {
	it("maps named keys case-insensitively", () => {
		expect(resolveKeySequence("Enter")).toBe("\r");
		expect(resolveKeySequence("enter")).toBe("\r");
		expect(resolveKeySequence("ESCAPE")).toBe("\x1b");
		expect(resolveKeySequence("PageUp")).toBe("\x1b[5~");
	});

	it("maps arrow keys to normal-mode xterm sequences", () => {
		expect(resolveKeySequence("Up")).toBe("\x1b[A");
		expect(resolveKeySequence("Down")).toBe("\x1b[B");
		expect(resolveKeySequence("Right")).toBe("\x1b[C");
		expect(resolveKeySequence("Left")).toBe("\x1b[D");
	});

	it("maps control chords to their control codes", () => {
		expect(resolveKeySequence("C-c")).toBe("\x03");
		expect(resolveKeySequence("C-d")).toBe("\x04");
		expect(resolveKeySequence("C-a")).toBe("\x01");
		expect(resolveKeySequence("C-[")).toBe("\x1b");
	});

	it("treats C-c and C-C the same", () => {
		expect(resolveKeySequence("C-C")).toBe(resolveKeySequence("C-c"));
	});

	it("maps meta chords to an ESC prefix", () => {
		expect(resolveKeySequence("M-b")).toBe("\x1bb");
	});

	it("passes a single printable character through", () => {
		expect(resolveKeySequence("x")).toBe("x");
	});

	it("rejects an unknown multi-character name", () => {
		expect(() => resolveKeySequence("Frobnicate")).toThrow(ControlError);
	});

	it("rejects an empty key", () => {
		expect(() => resolveKeySequence("   ")).toThrow(ControlError);
	});
});
