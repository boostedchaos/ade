import { describe, expect, it } from "bun:test";
import { pickRealBinaryPath } from "./utils";

describe("pickRealBinaryPath", () => {
	describe("posix", () => {
		const home = "/Users/dev";

		it("skips ~/.ade/bin and ~/.ade-*/bin wrappers, returns the real binary", () => {
			const candidates = [
				"/Users/dev/.ade/bin/claude",
				"/Users/dev/.ade-myworkspace/bin/claude",
				"/opt/homebrew/bin/claude",
			];
			expect(pickRealBinaryPath(candidates, home, false)).toBe(
				"/opt/homebrew/bin/claude",
			);
		});

		it("is case-sensitive on posix (a differently-cased ade dir is NOT skipped)", () => {
			const candidates = [
				"/Users/dev/.ADE/bin/claude",
				"/usr/local/bin/claude",
			];
			// POSIX filesystems are case-sensitive, so `.ADE` is a real (non-wrapper) dir.
			expect(pickRealBinaryPath(candidates, home, false)).toBe(
				"/Users/dev/.ADE/bin/claude",
			);
		});

		it("returns null when every candidate is a wrapper", () => {
			expect(
				pickRealBinaryPath(["/Users/dev/.ade/bin/claude"], home, false),
			).toBeNull();
		});
	});

	describe("windows", () => {
		const home = "C:\\Users\\dev";

		it("skips .ade\\bin and .ade-*\\bin wrappers using backslash separators", () => {
			const candidates = [
				"C:\\Users\\dev\\.ade\\bin\\claude.cmd",
				"C:\\Users\\dev\\.ade-myworkspace\\bin\\claude.cmd",
				"C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
			];
			expect(pickRealBinaryPath(candidates, home, true)).toBe(
				"C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
			);
		});

		it("is case-insensitive on windows (differently-cased ADE dir IS skipped)", () => {
			const candidates = [
				"C:\\Users\\dev\\.ADE\\Bin\\claude.cmd",
				"C:\\Program Files\\nodejs\\claude.cmd",
			];
			expect(pickRealBinaryPath(candidates, home, true)).toBe(
				"C:\\Program Files\\nodejs\\claude.cmd",
			);
		});

		it("returns null when every windows candidate is a wrapper", () => {
			expect(
				pickRealBinaryPath(
					["C:\\Users\\dev\\.ade-ws\\bin\\codex.ps1"],
					home,
					true,
				),
			).toBeNull();
		});
	});
});
