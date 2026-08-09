import { describe, expect, it } from "bun:test";
// The CLI's encoder is the AUTHORITY for `ade send-key`; this server-side
// table is only the fallback for callers that omit `data`. Imported through
// the package's documented library surface (packages/cli/src/lib.ts) via a
// test-only devDependency edge — never `src/index.ts`, which runs the CLI.
import {
	knownKeyNames as cliKnownKeyNames,
	encodeKey,
	UnknownKeyError,
} from "@ade/cli";
import { knownKeyNames, resolveKeySequence } from "./keys";
import { ControlError } from "./protocol";

/**
 * CROSS-PACKAGE CONTRACT TEST.
 *
 * `ade send-key` sends `{pane, key, data}` and the server writes `data`, so in
 * normal operation only the CLI's table is used. But the server keeps a
 * fallback table for `data`-less callers, and two copies of an encoding table
 * drift silently — the failure mode is a key that quietly sends the wrong
 * bytes to a live agent pane, which nothing else would catch.
 *
 * This pins them together: for every name the CLI knows, both encoders must
 * produce identical bytes, and neither may know a name the other does not.
 */

function encodeWithServer(
	key: string,
): { ok: true; bytes: string } | { ok: false } {
	try {
		return { ok: true, bytes: resolveKeySequence(key) };
	} catch (error) {
		// Both sides rejecting a key counts as agreement; the error TYPES
		// differ by design (the server maps to a wire error code).
		if (error instanceof ControlError) return { ok: false };
		throw error;
	}
}

function encodeWithCli(
	key: string,
): { ok: true; bytes: string } | { ok: false } {
	try {
		return { ok: true, bytes: encodeKey(key) };
	} catch (error) {
		if (error instanceof UnknownKeyError) return { ok: false };
		throw error;
	}
}

describe("send-key encoding contract with @ade/cli", () => {
	const cliNames = cliKnownKeyNames();

	it("the CLI actually exposes a non-trivial key table", () => {
		// Guards the whole suite: an empty list would make every it.each below
		// vacuously pass and the contract would be unchecked while green.
		expect(cliNames.length).toBeGreaterThan(20);
	});

	it("both sides know exactly the same set of named keys", () => {
		expect(knownKeyNames().sort()).toEqual([...cliNames].sort());
	});

	it.each(cliNames)("encodes %p identically on both sides", (name) => {
		expect(encodeWithServer(name)).toEqual(encodeWithCli(name));
	});

	it.each(cliNames)("encodes %p identically when upper-cased", (name) => {
		const upper = name.toUpperCase();
		expect(encodeWithServer(upper)).toEqual(encodeWithCli(upper));
	});

	// Chords and bare characters are generated, not table-driven, so they need
	// their own coverage — a divergence in the modifier parser would not show
	// up in the named-key sweep above.
	const chords = [
		"C-a",
		"C-c",
		"C-z",
		"C-A",
		"C-@",
		"C- ",
		"C-space",
		"C-[",
		"C-\\",
		"C-]",
		"C-^",
		"C-_",
		"C-?",
		"C-1",
		"C-",
		"M-b",
		"M-B",
		"M-x",
		"M-",
		"M-Enter",
		"M-Up",
		"C-M-a",
		"M-C-a",
		"C-M-Enter",
		"a",
		"Z",
		"1",
		"~",
		" ",
		"é",
		"",
		"Frobnicate",
		"C-Frobnicate",
	];

	it.each(
		chords,
	)("encodes chord/literal %p identically on both sides", (key) => {
		expect(encodeWithServer(key)).toEqual(encodeWithCli(key));
	});

	it("agrees on every single ASCII printable character", () => {
		for (let code = 0x20; code <= 0x7e; code += 1) {
			const char = String.fromCharCode(code);
			expect(encodeWithServer(char)).toEqual(encodeWithCli(char));
			expect(encodeWithServer(`C-${char}`)).toEqual(encodeWithCli(`C-${char}`));
			expect(encodeWithServer(`M-${char}`)).toEqual(encodeWithCli(`M-${char}`));
		}
	});
});
