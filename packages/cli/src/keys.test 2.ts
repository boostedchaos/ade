import { describe, expect, it } from "bun:test";
import { encodeKey, knownKeyNames, UnknownKeyError } from "./keys";

const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);

describe("encodeKey", () => {
	it("encodes Enter as a carriage return", () => {
		expect(encodeKey("Enter")).toBe("\r");
	});

	it("is case-insensitive on named keys", () => {
		expect(encodeKey("enter")).toBe("\r");
		expect(encodeKey("ENTER")).toBe("\r");
	});

	it("encodes Escape and Tab", () => {
		expect(encodeKey("Escape")).toBe(ESC);
		expect(encodeKey("Esc")).toBe(ESC);
		expect(encodeKey("Tab")).toBe("\t");
	});

	it("encodes arrow keys as CSI sequences", () => {
		expect(encodeKey("Up")).toBe(`${ESC}[A`);
		expect(encodeKey("Down")).toBe(`${ESC}[B`);
		expect(encodeKey("Right")).toBe(`${ESC}[C`);
		expect(encodeKey("Left")).toBe(`${ESC}[D`);
	});

	it("encodes BSpace as DEL, not backspace", () => {
		expect(encodeKey("BSpace")).toBe(DEL);
	});

	it("encodes function keys", () => {
		expect(encodeKey("F1")).toBe(`${ESC}OP`);
		expect(encodeKey("F5")).toBe(`${ESC}[15~`);
		expect(encodeKey("F12")).toBe(`${ESC}[24~`);
	});

	it("encodes C-<letter> as the control character", () => {
		expect(encodeKey("C-c")).toBe(String.fromCharCode(3));
		expect(encodeKey("C-C")).toBe(String.fromCharCode(3));
		expect(encodeKey("C-a")).toBe(String.fromCharCode(1));
		expect(encodeKey("C-z")).toBe(String.fromCharCode(26));
	});

	it("encodes the non-letter control keys", () => {
		expect(encodeKey("C-Space")).toBe(String.fromCharCode(0));
		expect(encodeKey("C-[")).toBe(ESC);
		expect(encodeKey("C-\\")).toBe(String.fromCharCode(28));
		expect(encodeKey("C-?")).toBe(DEL);
	});

	it("prefixes M- keys with escape", () => {
		expect(encodeKey("M-x")).toBe(`${ESC}x`);
		expect(encodeKey("M-Enter")).toBe(`${ESC}\r`);
	});

	it("combines C- and M- in either order", () => {
		expect(encodeKey("C-M-a")).toBe(ESC + String.fromCharCode(1));
		expect(encodeKey("M-C-a")).toBe(ESC + String.fromCharCode(1));
	});

	it("passes a single printable character through", () => {
		expect(encodeKey("q")).toBe("q");
		expect(encodeKey("1")).toBe("1");
	});

	it("rejects unknown multi-character names", () => {
		expect(() => encodeKey("Wat")).toThrow(UnknownKeyError);
		expect(() => encodeKey("")).toThrow(UnknownKeyError);
		expect(() => encodeKey("C-Wat")).toThrow(UnknownKeyError);
	});

	it("advertises every named key it can encode", () => {
		for (const name of knownKeyNames()) {
			expect(encodeKey(name).length).toBeGreaterThan(0);
		}
	});
});
