import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { execLine, shWrap, singleQuote } from "./quote";

// These tests execute a real POSIX /bin/sh, which does not exist on Windows.
// The escaping is POSIX-shell semantics only, so skipping on win32 loses no
// meaningful coverage there. The pure string-shape assertions still run.
const skipWin = process.platform === "win32";

/**
 * These assert the PROPERTY (a real /bin/sh reproduces the payload byte for
 * byte), not a snapshot of the escaped string — a snapshot would keep passing
 * if the escaping changed to something equally wrong-looking but broken.
 */
const PAYLOADS = [
	"plain",
	"cd /tmp && env A=1 claude --agent-id helper@team",
	"it's got an apostrophe",
	"''",
	"'; rm -rf /; echo '",
	'double "quotes" inside',
	"dollar $HOME and $(whoami) and `date`",
	"back\\slash",
	"newline\nin the middle",
	"tab\there",
	"trailing quote'",
	"'leading quote",
	"emoji 🚀 and ünïcödé",
	"* ? [ ] { } | & ; < > ( ) ! # ~",
];

describe("singleQuote", () => {
	it.skipIf(skipWin)("round-trips every payload through a real /bin/sh", () => {
		for (const payload of PAYLOADS) {
			const result = spawnSync("/bin/sh", [
				"-c",
				`printf %s ${singleQuote(payload)}`,
			]);
			expect(result.status).toBe(0);
			expect(result.stdout.toString()).toBe(payload);
		}
	});
});

describe("shWrap", () => {
	it.skipIf(skipWin)("survives a second escaping pass (the nesting respawn actually does)", () => {
		// The real path double-nests: the teammate command is itself built with
		// quoting, then wrapped again. Anything that escapes only one level
		// passes the simple case and fails here.
		for (const payload of PAYLOADS) {
			const inner = `printf %s ${singleQuote(payload)}`;
			const result = spawnSync("/bin/sh", ["-c", shWrap(inner)]);
			expect(result.status).toBe(0);
			expect(result.stdout.toString()).toBe(payload);
		}
	});

	it("always wraps, never classifies", () => {
		// SPEC hard rule: no command shape is exempt, not even a bare binary.
		expect(shWrap("ls")).toBe("/bin/sh -c 'ls'");
		expect(shWrap("cd /a && b")).toBe("/bin/sh -c 'cd /a && b'");
	});

	it.skipIf(skipWin)("reproduces the probe's verbatim teammate command", () => {
		const teammate =
			"cd /tmp/proj && env CLAUDECODE=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 " +
			"/Users/x/.local/share/claude/versions/2.1.226 --agent-id helper@session-e36bd9ce " +
			"--agent-name helper --dangerously-skip-permissions --model claude-opus-5";
		const result = spawnSync("/bin/sh", [
			"-c",
			shWrap(`printf %s ${singleQuote(teammate)}`),
		]);
		expect(result.stdout.toString()).toBe(teammate);
	});
});

describe("execLine", () => {
	it("prefixes exec so the placeholder shell is replaced, not nested", () => {
		expect(execLine("claude --x")).toBe("exec /bin/sh -c 'claude --x'");
	});

	it.skipIf(skipWin)("replaces the placeholder shell instead of nesting under it", () => {
		// This is the property the pane depends on: after the exec there is ONE
		// process, so closing the pane kills the teammate and the teammate
		// exiting ends the pane. Printing $$ either side proves the pid is reused.
		const result = spawnSync("/bin/sh", [
			"-c",
			`printf '%s ' $$; ${execLine("printf %s $$")}`,
		]);
		expect(result.status).toBe(0);
		const [before, after] = result.stdout.toString().trim().split(" ");
		expect(before).toMatch(/^\d+$/);
		expect(after).toBe(before);
	});
});
