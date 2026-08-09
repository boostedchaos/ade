/**
 * `ade claude-teams` launcher tests.
 *
 * The env/argv assembly is asserted by actually SPAWNING a stub `claude` that
 * dumps what it received — a mocked spawn would only prove the plan object,
 * not that the child really inherits the shim PATH and the teams env.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../errors";
import { CompatStore, defaultStoreDir } from "../tmux-compat/store";
import {
	buildLaunch,
	LAUNCHES_DIRNAME,
	LEADER_PANE_ID,
	launchStoreDir,
	materializeShim,
	resolveInvocation,
	runClaudeTeams,
	SHIM_DIRNAME,
	shimScript,
} from "./teams";

// claude-teams is macOS-only (win32 exits 2), and these tests spawn POSIX
// /bin/sh shims and assert executable bits and ':'-delimited PATHs. Skip the
// POSIX-semantics ones on win32; the win32-refusal test below still runs.
const skipWin = process.platform === "win32";

let dir: string;
let dumpPath: string;

function captureIo() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		stdout: (line: string) => out.push(line),
		stderr: (line: string) => err.push(line),
	};
}

/** A stub `claude` that writes its argv and the env keys we care about. */
function installStubClaude(binDir: string, exitCode = 0): string {
	const path = join(binDir, "claude");
	writeFileSync(
		path,
		[
			"#!/bin/sh",
			`{`,
			`  echo "ARGV: $*"`,
			`  echo "PATH=$PATH"`,
			`  echo "TMUX=$TMUX"`,
			`  echo "TMUX_PANE=$TMUX_PANE"`,
			`  echo "TEAMS=$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"`,
			`  echo "SURFACE=$ADE_SURFACE_ID"`,
			`  echo "TMUX_RESOLVED=$(command -v tmux)"`,
			`  echo "COMPAT_DIR=$ADE_TMUX_COMPAT_DIR"`,
			`} > "$ADE_TEST_DUMP"`,
			`exit ${exitCode}`,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(path, 0o755);
	return path;
}

function dump(): Record<string, string> {
	const text = readFileSync(dumpPath, "utf8");
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const at = line.indexOf(line.startsWith("ARGV") ? ": " : "=");
		if (at === -1) continue;
		out[line.slice(0, at)] = line.slice(at + (line.startsWith("ARGV") ? 2 : 1));
	}
	return out;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ade-teams-"));
	dumpPath = join(dir, "dump.txt");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("shim materialization", () => {
	it.skipIf(skipWin)("writes an executable tmux that execs `ade tmux-compat`", () => {
		const shimDir = materializeShim(dir, "'/bin/bun' '/repo/cli.ts'");
		const path = join(shimDir, "tmux");
		expect(shimDir).toBe(join(dir, SHIM_DIRNAME));
		const content = readFileSync(path, "utf8");
		expect(content).toStartWith("#!/bin/sh\n");
		expect(content).toContain(
			`exec '/bin/bun' '/repo/cli.ts' tmux-compat "$@"`,
		);
		expect(statSync(path).mode & 0o111).toBeGreaterThan(0);
	});

	it("is idempotent — rewriting produces the identical file", () => {
		materializeShim(dir, "ade-invocation");
		const path = join(dir, SHIM_DIRNAME, "tmux");
		const first = readFileSync(path, "utf8");
		materializeShim(dir, "ade-invocation");
		expect(readFileSync(path, "utf8")).toBe(first);
	});

	it.skipIf(skipWin)("forwards argv verbatim through the shim to tmux-compat", () => {
		// The shim is a real shell script; run it with a stub `ade` to prove the
		// "$@" quoting survives arguments containing spaces and quotes.
		const echo = join(dir, "echo-args.sh");
		writeFileSync(echo, '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n', {
			mode: 0o755,
		});
		const shimDir = materializeShim(dir, `'${echo}'`);
		const result = spawnSync(join(shimDir, "tmux"), [
			"-S",
			"/fake-socket",
			"respawn-pane",
			"-k",
			"-t",
			"%1",
			"--",
			"cd /a && claude --prompt 'hi there'",
		]);
		expect(result.status).toBe(0);
		expect(result.stdout.toString()).toBe(
			[
				"[tmux-compat]",
				"[-S]",
				"[/fake-socket]",
				"[respawn-pane]",
				"[-k]",
				"[-t]",
				"[%1]",
				"[--]",
				"[cd /a && claude --prompt 'hi there']",
				"",
			].join("\n"),
		);
	});

	it("prefers an explicit ADE_CLI_INVOCATION, else interpreter + script", () => {
		expect(
			resolveInvocation({ ADE_CLI_INVOCATION: "ade" }, "/bin/bun", "/x.ts"),
		).toBe("ade");
		expect(resolveInvocation({}, "/bin/bun", "/x.ts")).toBe(
			"'/bin/bun' '/x.ts'",
		);
		expect(resolveInvocation({}, "/bin/bun", undefined)).toBe("ade");
	});

	it("quotes an interpreter path containing spaces", () => {
		const script = shimScript(
			resolveInvocation({}, "/Applications/My App/bun", "/repo/a b/cli.ts"),
		);
		expect(script).toContain(
			`exec '/Applications/My App/bun' '/repo/a b/cli.ts' tmux-compat "$@"`,
		);
	});
});

describe("launch plan", () => {
	it.skipIf(skipWin)("prepends the shim dir and sets the teams env", () => {
		const plan = buildLaunch([], { PATH: "/usr/bin" }, "/shim", "/compat");
		expect(plan.env.PATH).toBe("/shim:/usr/bin");
		expect(plan.env.TMUX).toBe("/fake-socket,0,0");
		expect(plan.env.TMUX_PANE).toBe(LEADER_PANE_ID);
		expect(plan.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
	});

	it("appends --teammate-mode tmux (the env var alone gives in-process)", () => {
		expect(buildLaunch(["--continue"], {}, "/shim", "/compat").args).toEqual([
			"--continue",
			"--teammate-mode",
			"tmux",
		]);
	});

	it("does not override an explicit --teammate-mode", () => {
		expect(
			buildLaunch(["--teammate-mode", "iterm2"], {}, "/shim", "/compat").args,
		).toEqual(["--teammate-mode", "iterm2"]);
	});

	it("passes model and other claude args through verbatim", () => {
		expect(
			buildLaunch(
				["--model", "claude-opus-5", "-p", "hi"],
				{},
				"/shim",
				"/compat",
			).args,
		).toEqual([
			"--model",
			"claude-opus-5",
			"-p",
			"hi",
			"--teammate-mode",
			"tmux",
		]);
	});
});

describe("runClaudeTeams", () => {
	it("refuses on win32 with exit 2", async () => {
		const io = captureIo();
		expect(
			await runClaudeTeams([], io, { platform: "win32", adeDir: dir }),
		).toBe(EXIT.USAGE);
		expect(io.err.join()).toContain("macOS only in v1");
		expect(existsSync(join(dir, SHIM_DIRNAME))).toBe(false);
	});

	it.skipIf(skipWin)("launches claude with the shim on PATH and returns its exit code", async () => {
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		installStubClaude(binDir, 7);
		const io = captureIo();

		const code = await runClaudeTeams(["--continue"], io, {
			platform: "darwin",
			adeDir: dir,
			isTty: true,
			env: {
				PATH: binDir,
				ADE_SURFACE_ID: "ade-pane-42",
				ADE_TEST_DUMP: dumpPath,
				ADE_CLI_INVOCATION: "ade",
			},
		});

		expect(code).toBe(7);
		const captured = dump();
		expect(captured.ARGV).toBe("--continue --teammate-mode tmux");
		expect(captured.TMUX).toBe("/fake-socket,0,0");
		expect(captured.TMUX_PANE).toBe("%0");
		expect(captured.TEAMS).toBe("1");
		expect(captured.SURFACE).toBe("ade-pane-42");
		// The decisive assertion: `tmux` inside the child resolves to OUR shim.
		expect(captured.TMUX_RESOLVED).toBe(join(dir, SHIM_DIRNAME, "tmux"));
	});

	it("warns instead of refusing when stdout is not a TTY", async () => {
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		installStubClaude(binDir);
		const io = captureIo();
		await runClaudeTeams([], io, {
			platform: "darwin",
			adeDir: dir,
			isTty: false,
			env: { PATH: binDir, ADE_TEST_DUMP: dumpPath, ADE_CLI_INVOCATION: "ade" },
		});
		expect(io.err.join()).toContain("not a TTY");
		expect(io.err.join()).toContain("in-process");
	});

	it("reports a missing claude binary as a usage failure", async () => {
		const io = captureIo();
		const code = await runClaudeTeams([], io, {
			platform: "darwin",
			adeDir: dir,
			isTty: true,
			env: {
				PATH: join(dir, "empty"),
				ADE_CLAUDE_BIN: join(dir, "no-such-claude"),
				ADE_CLI_INVOCATION: "ade",
			},
		});
		expect(code).toBe(EXIT.USAGE);
		expect(io.err.join()).toContain("not on PATH");
	});

	it("seeds the store fresh, binding %0 to this pane", async () => {
		const store = new CompatStore(dir);
		// A stale mapping from a previous launch must not survive: %1 would point
		// at an ADE pane id that has since been recycled.
		await store.transact((data) => {
			data.panes["%1"] = {
				id: "%1",
				windowId: "@0",
				adePaneId: "stale-pane",
				title: null,
				options: {},
				state: "execed",
				command: "old",
			};
		});

		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		installStubClaude(binDir);
		await runClaudeTeams([], captureIo(), {
			platform: "darwin",
			adeDir: dir,
			isTty: true,
			store,
			env: {
				PATH: binDir,
				ADE_SURFACE_ID: "ade-pane-42",
				ADE_TEST_DUMP: dumpPath,
				ADE_CLI_INVOCATION: "ade",
			},
		});

		const data = new CompatStore(dir).read();
		expect(data.panes["%1"]).toBeUndefined();
		expect(data.panes["%0"]).toMatchObject({
			adePaneId: "ade-pane-42",
			state: "shell",
			windowId: "@0",
		});
		expect(data.counters).toEqual({ pane: 1, window: 1, session: 1 });
	});
});

/**
 * Concurrent launches. `seedStore` RESETS the store and rebinds `%0` to the
 * launching pane, so while every launch shared `~/.ade/`, starting a second
 * `ade claude-teams` wiped the first session's `%N → ADE pane` mappings and
 * repointed its leader. The first session's next teammate spawn then landed in
 * the second session's pane, or nowhere.
 */
describe("per-launch compat dir", () => {
	it("gives two launches different store dirs", () => {
		const a = launchStoreDir("/ade", {}, 111, 1_000);
		const b = launchStoreDir("/ade", {}, 222, 1_000);
		expect(a).not.toBe(b);
		expect(a.startsWith(join("/ade", LAUNCHES_DIRNAME))).toBe(true);
	});

	it("separates two launches from the same pid at different times", () => {
		expect(launchStoreDir("/ade", {}, 111, 1_000)).not.toBe(
			launchStoreDir("/ade", {}, 111, 2_000),
		);
	});

	it("honours an explicit ADE_TMUX_COMPAT_DIR", () => {
		expect(
			launchStoreDir("/ade", { ADE_TMUX_COMPAT_DIR: "/pinned" }, 1, 2),
		).toBe("/pinned");
	});

	it("puts the compat dir in the launch env for the shim to read", () => {
		const plan = buildLaunch([], {}, "/shim", "/compat/abc");
		expect(plan.env.ADE_TMUX_COMPAT_DIR).toBe("/compat/abc");
	});

	it("does NOT change the default dir for a bare tmux-compat call", () => {
		// The shim is only on PATH inside a launch; typed directly, `ade
		// tmux-compat` must still find the ordinary store.
		expect(defaultStoreDir({ HOME: "/home/x" })).not.toContain(
			LAUNCHES_DIRNAME,
		);
	});

	it.skipIf(skipWin)("the spawned claude actually receives the per-launch dir", async () => {
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		installStubClaude(binDir);
		const compatDir = join(dir, "launch-a");

		await runClaudeTeams([], captureIo(), {
			platform: "darwin",
			adeDir: dir,
			isTty: true,
			compatDir,
			env: {
				PATH: binDir,
				ADE_TEST_DUMP: dumpPath,
				ADE_CLI_INVOCATION: "ade",
			},
		});

		// Read from the child's own environment, not from the plan we built.
		expect(dump().COMPAT_DIR).toBe(compatDir);
		// And the seeded store landed there, not in the shared dir.
		expect(existsSync(join(compatDir, "tmux-compat-store.json"))).toBe(true);
		expect(existsSync(join(dir, "tmux-compat-store.json"))).toBe(false);
	});

	it("two launches seed independent stores", async () => {
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		installStubClaude(binDir);

		for (const [name, surface] of [
			["launch-1", "ade-pane-1"],
			["launch-2", "ade-pane-2"],
		] as const) {
			await runClaudeTeams([], captureIo(), {
				platform: "darwin",
				adeDir: dir,
				isTty: true,
				compatDir: join(dir, name),
				env: {
					PATH: binDir,
					ADE_SURFACE_ID: surface,
					ADE_TEST_DUMP: dumpPath,
					ADE_CLI_INVOCATION: "ade",
				},
			});
		}

		// The decisive assertion: launch 1's leader still points at ITS pane.
		// Sharing one dir, the second seedStore overwrote this with ade-pane-2.
		expect(
			new CompatStore(join(dir, "launch-1")).read().panes["%0"]?.adePaneId,
		).toBe("ade-pane-1");
		expect(
			new CompatStore(join(dir, "launch-2")).read().panes["%0"]?.adePaneId,
		).toBe("ade-pane-2");
	});
});
