import { describe, expect, it } from "bun:test";
import { longpathsCloneOptions } from "./agent-repo";

/**
 * Regression guard for issue #11: agent repo clones on stock Windows failed the
 * checkout with "Filename too long" because the deep
 * ~/.ade/agents/<uuid>/worktree/ prefix overflows MAX_PATH. The fix passes
 * `--config core.longpaths=true` to `git clone` on win32 itself instead of
 * relying on the user's global git config. This test fails if that config stops
 * being applied on Windows (or starts leaking onto other platforms).
 */
describe("longpathsCloneOptions", () => {
	it("enables core.longpaths on win32 clones", () => {
		const opts = longpathsCloneOptions("win32");
		// Reconstruct the flag exactly as git sees it: `--config <key>=<value>`.
		expect(opts.join(" ")).toBe("--config core.longpaths=true");
	});

	it("adds nothing on non-Windows platforms", () => {
		expect(longpathsCloneOptions("linux")).toEqual([]);
		expect(longpathsCloneOptions("darwin")).toEqual([]);
	});
});
