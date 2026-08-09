/**
 * The PTY spawn cap.
 *
 * Raised 3 → 8 for agent teams: a team spawn burst creates several panes back
 * to back, and at 3 the rest queue behind the cap so teammates trickle in.
 */
import { describe, expect, it } from "bun:test";
import "./xterm-env-polyfill";

// Dynamic import, matching session.test.ts: terminal-host pulls in
// @xterm/headless, which throws on `window` under Bun unless the polyfill has
// already RUN — and a static import would be hoisted above it.
const { resolveMaxConcurrentSpawns } = await import("./terminal-host");

describe("resolveMaxConcurrentSpawns", () => {
	it("defaults to 8 when the env var is unset or blank", () => {
		expect(resolveMaxConcurrentSpawns(undefined)).toBe(8);
		expect(resolveMaxConcurrentSpawns("")).toBe(8);
		expect(resolveMaxConcurrentSpawns("   ")).toBe(8);
	});

	it("accepts a positive integer override", () => {
		expect(resolveMaxConcurrentSpawns("1")).toBe(1);
		expect(resolveMaxConcurrentSpawns("16")).toBe(16);
		expect(resolveMaxConcurrentSpawns(" 4 ")).toBe(4);
	});

	it("falls back rather than throwing on a malformed value", () => {
		// A bad override must not stop the terminal host from starting at all.
		for (const bad of ["0", "-1", "abc", "3.5", "1e3", "NaN", "Infinity"]) {
			expect(resolveMaxConcurrentSpawns(bad)).toBe(8);
		}
	});

	it("reads ADE_MAX_CONCURRENT_SPAWNS from the environment by default", () => {
		const previous = process.env.ADE_MAX_CONCURRENT_SPAWNS;
		try {
			process.env.ADE_MAX_CONCURRENT_SPAWNS = "5";
			expect(resolveMaxConcurrentSpawns()).toBe(5);
			delete process.env.ADE_MAX_CONCURRENT_SPAWNS;
			expect(resolveMaxConcurrentSpawns()).toBe(8);
		} finally {
			if (previous === undefined) delete process.env.ADE_MAX_CONCURRENT_SPAWNS;
			else process.env.ADE_MAX_CONCURRENT_SPAWNS = previous;
		}
	});
});
