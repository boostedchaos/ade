/**
 * Which Claude Code the ACP adapter drives, and what happens when there isn't
 * one.
 *
 * The failure path is the reason this module is a pure function. Phase 2 ships
 * no bundled CLI, so "Claude Code is not installed" is a real, reachable state
 * — and the design's hard requirement is that it renders a message naming what
 * to install, never a hang and never a raw code. That is only testable if the
 * lookup can be run against a machine that has no `claude` on it, which no
 * assertion about the developer's own PATH can simulate.
 */

import { describe, expect, it } from "bun:test";
import {
	type ClaudeLookupIo,
	claudeNotFoundMessage,
	findClaudeExecutable,
} from "./claude-executable";

const HOME = "/Users/kyle";

function io(overrides: Partial<ClaudeLookupIo> = {}): ClaudeLookupIo {
	return {
		pathValue: "",
		home: HOME,
		override: undefined,
		pathSeparator: ":",
		isExecutableFile: () => false,
		readHead: () => "",
		...overrides,
	};
}

/** An IO whose only executables are the paths listed. */
function withExecutables(
	paths: string[],
	overrides: Partial<ClaudeLookupIo> = {},
): ClaudeLookupIo {
	return io({
		isExecutableFile: (candidate) => paths.includes(candidate),
		...overrides,
	});
}

describe("findClaudeExecutable — not found", () => {
	it("returns null when nothing on the machine is executable", () => {
		expect(findClaudeExecutable(io({ pathValue: "/usr/bin:/bin" }))).toBeNull();
	});

	it("returns null when the ONLY claude is an ADE wrapper dir", () => {
		// This is Kyle's actual machine: ~/.ade-default/bin/claude shadows the
		// real one on PATH. Choosing it would exec the real binary with
		// `--settings <ade hooks settings>` appended, registering the pane-status
		// hook set and giving the ACP pane a second status writer (D5).
		const found = findClaudeExecutable(
			withExecutables([`${HOME}/.ade-default/bin/claude`], {
				pathValue: `${HOME}/.ade-default/bin`,
			}),
		);
		expect(found).toBeNull();
	});

	it("returns null when the only claude on PATH is a wrapper SCRIPT", () => {
		// Belt and braces for a wrapper installed somewhere the dir rule misses:
		// every ADE shim carries the `agent-wrapper` marker in its header.
		const found = findClaudeExecutable(
			withExecutables(["/opt/shims/claude"], {
				pathValue: "/opt/shims",
				readHead: () => "#!/bin/bash\n# ADE agent-wrapper v2\n",
			}),
		);
		expect(found).toBeNull();
	});

	it("names what to install, and does not mention an env var value", () => {
		const message = claudeNotFoundMessage(undefined);
		expect(message).toContain("@anthropic-ai/claude-code");
		expect(message).toContain("CLAUDE_CODE_EXECUTABLE");
		// Not a bare code, and not empty: this string IS what the pane renders.
		expect(message.length).toBeGreaterThan(40);
		expect(message.startsWith("acp-")).toBe(false);
	});

	it("blames the override, not the install, when the override is bad", () => {
		const message = claudeNotFoundMessage("/nope/claude");
		expect(message).toContain("/nope/claude");
		expect(message).not.toContain("npm i -g");
	});
});

describe("findClaudeExecutable — found", () => {
	it("takes an executable CLAUDE_CODE_EXECUTABLE override first", () => {
		const found = findClaudeExecutable(
			withExecutables(["/custom/claude", "/usr/bin/claude"], {
				override: "/custom/claude",
				pathValue: "/usr/bin",
			}),
		);
		expect(found).toEqual({ path: "/custom/claude", source: "override" });
	});

	it("does NOT silently search when a bad override is set", () => {
		// Falling back would run a different CLI than the one the user named.
		const found = findClaudeExecutable(
			withExecutables(["/usr/bin/claude"], {
				override: "/gone/claude",
				pathValue: "/usr/bin",
			}),
		);
		expect(found).toBeNull();
	});

	it("skips wrapper dirs and takes the next PATH entry", () => {
		const found = findClaudeExecutable(
			withExecutables(
				[`${HOME}/.ade-default/bin/claude`, `${HOME}/.local/bin/claude`],
				{ pathValue: `${HOME}/.ade-default/bin:${HOME}/.local/bin` },
			),
		);
		expect(found).toEqual({
			path: `${HOME}/.local/bin/claude`,
			source: "path",
		});
	});

	it("skips ~/.superset/bin too (the pre-rename wrapper dir)", () => {
		const found = findClaudeExecutable(
			withExecutables(
				[`${HOME}/.superset/bin/claude`, "/opt/homebrew/bin/claude"],
				{ pathValue: `${HOME}/.superset/bin:/opt/homebrew/bin` },
			),
		);
		expect(found?.path).toBe("/opt/homebrew/bin/claude");
	});

	it("does not mistake a normal dir under home for a wrapper dir", () => {
		const found = findClaudeExecutable(
			withExecutables([`${HOME}/bin/claude`], { pathValue: `${HOME}/bin` }),
		);
		expect(found?.path).toBe(`${HOME}/bin/claude`);
	});

	it("falls back to a well-known location when PATH is the launchd stub", () => {
		// Electron's PATH when the app is opened from Finder holds none of the
		// user's shell additions, so a claude every terminal can see is invisible
		// here. Without this branch the pane says "not installed" on a machine
		// that has it.
		const found = findClaudeExecutable(
			withExecutables([`${HOME}/.local/bin/claude`], {
				pathValue: "/usr/bin:/bin:/usr/sbin:/sbin",
			}),
		);
		expect(found).toEqual({
			path: `${HOME}/.local/bin/claude`,
			source: "well-known",
		});
	});

	it("prefers a PATH hit over a well-known location", () => {
		const found = findClaudeExecutable(
			withExecutables(["/opt/custom/claude", `${HOME}/.local/bin/claude`], {
				pathValue: "/opt/custom",
			}),
		);
		expect(found?.source).toBe("path");
	});

	it("ignores empty PATH segments", () => {
		const found = findClaudeExecutable(
			withExecutables(["/usr/bin/claude"], { pathValue: ":/usr/bin:" }),
		);
		expect(found?.path).toBe("/usr/bin/claude");
	});
});
