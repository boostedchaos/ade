import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as realOs from "node:os";
import path from "node:path";

const TEST_ROOT = path.join(
	realOs.tmpdir(),
	`superset-agent-wrappers-${process.pid}-${Date.now()}`,
);
const TEST_BIN_DIR = path.join(TEST_ROOT, "superset", "bin");
const TEST_HOOKS_DIR = path.join(TEST_ROOT, "superset", "hooks");
const TEST_ZSH_DIR = path.join(TEST_ROOT, "superset", "zsh");
const TEST_BASH_DIR = path.join(TEST_ROOT, "superset", "bash");
const TEST_OPENCODE_CONFIG_DIR = path.join(TEST_HOOKS_DIR, "opencode");
const TEST_OPENCODE_PLUGIN_DIR = path.join(TEST_OPENCODE_CONFIG_DIR, "plugin");
let mockedHomeDir = path.join(TEST_ROOT, "home");

mock.module("../env.shared", () => ({
	env: {
		DESKTOP_NOTIFICATIONS_PORT: 7777,
	},
	getWorkspaceName: () => undefined,
}));

mock.module("./notify-hook", () => ({
	NOTIFY_SCRIPT_NAME: "notify.sh",
	NOTIFY_SCRIPT_MARKER: "# Superset agent notification hook",
	getNotifyScriptPath: () => path.join(TEST_HOOKS_DIR, "notify.sh"),
	getNotifyScriptContent: () => "#!/bin/bash\nexit 0\n",
	createNotifyScript: () => {},
}));

mock.module("./paths", () => ({
	BIN_DIR: TEST_BIN_DIR,
	HOOKS_DIR: TEST_HOOKS_DIR,
	ZSH_DIR: TEST_ZSH_DIR,
	BASH_DIR: TEST_BASH_DIR,
	OPENCODE_CONFIG_DIR: TEST_OPENCODE_CONFIG_DIR,
	OPENCODE_PLUGIN_DIR: TEST_OPENCODE_PLUGIN_DIR,
}));

mock.module("node:os", () => ({
	...realOs,
	homedir: () => mockedHomeDir,
	default: {
		...realOs,
		homedir: () => mockedHomeDir,
	},
}));

const {
	buildCodexWrapperExecLine,
	buildCopilotWrapperExecLine,
	buildWrapperScript,
	createCodexWrapper,
	createMastraWrapper,
	backupClaudeSettings,
	CLAUDE_HOOK_EVENTS,
	getClaudeSettingsContent,
	readClaudeHookCoverage,
	getCursorHooksJsonContent,
	getCopilotHookScriptPath,
	getGeminiSettingsJsonContent,
	getMastraHooksJsonContent,
	getOpenCodePluginContent,
} = await import("./agent-wrappers");

const {
	buildCodexNotifyOverride,
	createShimRuntime,
	createWindowsShim,
	getShimRuntimePath,
	nodeHookCommand,
} = await import("./agent-wrappers-common");

describe("agent-wrappers copilot", () => {
	beforeEach(() => {
		mockedHomeDir = path.join(TEST_ROOT, "home");
		mkdirSync(TEST_BIN_DIR, { recursive: true });
		mkdirSync(TEST_HOOKS_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	});

	// bun mock.module("node:os") leaks into every later test file in the
	// shared process; point the mocked homedir back at the real home so the
	// daemon integration tests see true paths again.
	afterAll(() => {
		mockedHomeDir = process.env.USERPROFILE || process.env.HOME || mockedHomeDir;
	});

	// Executes a bash wrapper script — posix-only (Windows cannot exec .sh).
	it.skipIf(process.platform === "win32")("rewrites stale superset-notify.json with current hook path", () => {
		const projectDir = path.join(TEST_ROOT, "project");
		const hooksDir = path.join(projectDir, ".github", "hooks");
		const hookFile = path.join(hooksDir, "superset-notify.json");
		const gitInfoDir = path.join(projectDir, ".git", "info");
		const realBinDir = path.join(TEST_ROOT, "real-bin");
		const realCopilot = path.join(realBinDir, "copilot");
		const wrapperPath = path.join(TEST_BIN_DIR, "copilot");
		const hookScriptPath = getCopilotHookScriptPath();

		mkdirSync(hooksDir, { recursive: true });
		mkdirSync(gitInfoDir, { recursive: true });
		mkdirSync(realBinDir, { recursive: true });

		writeFileSync(hookScriptPath, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
		writeFileSync(hookFile, '{"superset":"old","bash":"/tmp/old-hook.sh"}');

		writeFileSync(realCopilot, "#!/bin/bash\necho real-copilot\n", {
			mode: 0o755,
		});
		chmodSync(realCopilot, 0o755);

		const wrapperScript = buildWrapperScript(
			"copilot",
			buildCopilotWrapperExecLine(),
		);
		writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 });
		chmodSync(wrapperPath, 0o755);

		execFileSync(wrapperPath, [], {
			cwd: projectDir,
			env: {
				...process.env,
				PATH: `${TEST_BIN_DIR}:${realBinDir}:${process.env.PATH || ""}`,
				SUPERSET_TAB_ID: "tab-1",
			},
			encoding: "utf-8",
		});

		const updated = readFileSync(hookFile, "utf-8");
		expect(updated).toContain(hookScriptPath);
		expect(updated).not.toContain("/tmp/old-hook.sh");
	});

	it.skipIf(process.platform === "win32")("injects codex message-start watcher + completion notifications in wrapper", () => {
		createCodexWrapper();

		const wrapperPath = path.join(TEST_BIN_DIR, "codex");
		const wrapper = readFileSync(wrapperPath, "utf-8");

		expect(wrapper).toContain("export CODEX_TUI_RECORD_SESSION=1");
		expect(wrapper).toContain('"type":"task_started"');
		expect(wrapper).toContain('_superset_last_turn_id=""');
		expect(wrapper).toContain("_superset_turn_id=$(printf");
		expect(wrapper).toContain('awk -F\'"turn_id":"\'');
		expect(wrapper).toContain('{"hook_event_name":"Start"}');
		expect(wrapper).toContain(
			`"$REAL_BIN" -c 'notify=["bash","${path.join(TEST_HOOKS_DIR, "notify.sh")}"]' "$@"`,
		);
		expect(wrapper).toContain("SUPERSET_CODEX_START_WATCHER_PID");
		expect(wrapper).toContain('kill "$SUPERSET_CODEX_START_WATCHER_PID"');

		const execLine = buildCodexWrapperExecLine(
			path.join(TEST_HOOKS_DIR, "notify.sh"),
		);
		expect(execLine).not.toContain("{{NOTIFY_PATH}}");
		expect(wrapper).toContain(execLine);
	});

	it.skipIf(process.platform === "win32")("creates mastracode wrapper passthrough", () => {
		createMastraWrapper();

		const wrapperPath = path.join(TEST_BIN_DIR, "mastracode");
		const wrapper = readFileSync(wrapperPath, "utf-8");

		expect(wrapper).toContain("# ADE wrapper for mastracode");
		expect(wrapper).toContain('REAL_BIN="$(find_real_binary "mastracode")"');
		expect(wrapper).toContain('exec "$REAL_BIN" "$@"');
	});

	describe("windows shims", () => {
		it("nodeHookCommand quotes the path and appends the event arg", () => {
			expect(nodeHookCommand("C:\\Users\\dev\\.ade\\hooks\\notify.mjs")).toBe(
				'node "C:\\Users\\dev\\.ade\\hooks\\notify.mjs"',
			);
			expect(
				nodeHookCommand("C:\\Users\\dev\\.ade\\hooks\\cursor-hook.mjs", "Start"),
			).toBe('node "C:\\Users\\dev\\.ade\\hooks\\cursor-hook.mjs" Start');
		});

		it("createWindowsShim writes a .cmd (only) that delegates to the node launcher", () => {
			createWindowsShim("claude");

			const shimPath = getShimRuntimePath();
			const cmd = readFileSync(path.join(TEST_BIN_DIR, "claude.cmd"), "utf-8");

			expect(cmd).toContain("@echo off");
			// Header carries the "agent-wrapper" needle so the resolver skips it.
			expect(cmd).toContain("agent-wrapper");
			expect(cmd).toContain(`node "${shimPath}" claude %*`);

			// No .ps1 is generated (PowerShell prefers .ps1 and a Restricted policy
			// would block it with no fallback; PowerShell runs .cmd fine).
			expect(existsSync(path.join(TEST_BIN_DIR, "claude.ps1"))).toBe(false);
		});

		it("createWindowsShim removes a stale .ps1 left by an earlier build", () => {
			writeFileSync(
				path.join(TEST_BIN_DIR, "codex.ps1"),
				"# stale ADE agent-wrapper shim\n",
			);
			createWindowsShim("codex");
			expect(existsSync(path.join(TEST_BIN_DIR, "codex.cmd"))).toBe(true);
			expect(existsSync(path.join(TEST_BIN_DIR, "codex.ps1"))).toBe(false);
		});

		it("buildCodexNotifyOverride emits a TOML literal-string array (fix #1)", () => {
			const notifyMjs = "C:\\Users\\dev\\.ade\\hooks\\notify.mjs";
			const override = buildCodexNotifyOverride(notifyMjs);
			// Single-quoted (TOML literal) so backslashes are NOT doubled and no
			// double quotes exist to be mangled by the cmd.exe /c hop.
			expect(override).toBe(
				"notify=['node','C:\\Users\\dev\\.ade\\hooks\\notify.mjs']",
			);
			expect(override).not.toContain('"');
			expect(override).not.toContain("\\\\");
		});

		it("opencode plugin JSON-escapes the notify path so Windows backslashes survive (fix #2)", () => {
			const notifyPath = "C:\\Users\\dev\\.ade\\hooks\\notify.mjs";
			const content = getOpenCodePluginContent(notifyPath);
			// Emitted as a valid, properly-escaped JS string literal.
			expect(content).toContain(
				'const notifyPath = "C:\\\\Users\\\\dev\\\\.ade\\\\hooks\\\\notify.mjs";',
			);
			// The raw (unescaped) form that would corrupt the path must NOT appear.
			expect(content).not.toContain('"C:\\Users\\dev\\.ade\\hooks\\notify.mjs"');
			expect(content).not.toContain("{{NOTIFY_PATH_JSON}}");
		});

		it("createShimRuntime bakes the per-agent config into agent-shim.mjs", () => {
			const shimPath = getShimRuntimePath();
			createShimRuntime({
				binDir: TEST_BIN_DIR,
				notifyMjs: path.join(TEST_HOOKS_DIR, "notify.mjs"),
				installInfo: {
					claude: {
						label: "Claude Code",
						command: "npm i -g @anthropic-ai/claude-code",
						url: "https://claude.com/claude-code",
					},
				},
				agents: {
					claude: { extraArgs: ["--settings", "C:\\settings.json"] },
					codex: { codexWatcher: true },
				},
			});

			const runtime = readFileSync(shimPath, "utf-8");
			// The template's static launcher logic survives substitution...
			expect(runtime).toContain("function findRealBinary");
			expect(runtime).toContain("startCodexWatcher");
			// ...and the baked config is valid, parseable JSON in the CONFIG slot.
			expect(runtime).toContain("const CONFIG = {");
			expect(runtime).toContain('"codexWatcher": true');
			expect(runtime).toContain('"--settings"');
			expect(runtime).not.toContain("{{CONFIG}}");
			expect(runtime).not.toContain("{{MARKER}}");
		});
	});

	it.skipIf(process.platform === "win32")("replaces stale Cursor hook commands from old superset paths", () => {
		const cursorHooksPath = path.join(mockedHomeDir, ".cursor", "hooks.json");
		const staleHookPath = "/tmp/.ade-old/hooks/cursor-hook.sh";
		const currentHookPath = "/tmp/.ade-new/hooks/cursor-hook.sh";

		mkdirSync(path.dirname(cursorHooksPath), { recursive: true });
		writeFileSync(
			cursorHooksPath,
			JSON.stringify(
				{
					version: 1,
					hooks: {
						beforeSubmitPrompt: [
							{ command: `${staleHookPath} Start` },
							{ command: "/usr/local/bin/custom-hook Start" },
						],
					},
				},
				null,
				2,
			),
		);

		const content = getCursorHooksJsonContent(currentHookPath);
		writeFileSync(cursorHooksPath, content);
		const content2 = getCursorHooksJsonContent(currentHookPath);

		const parsed = JSON.parse(content) as {
			hooks: Record<string, Array<{ command: string }>>;
		};
		const beforeSubmitPrompt = parsed.hooks.beforeSubmitPrompt;

		expect(
			beforeSubmitPrompt.some(
				(entry) => entry.command === `${currentHookPath} Start`,
			),
		).toBe(true);
		expect(
			beforeSubmitPrompt.some((entry) => entry.command.includes(staleHookPath)),
		).toBe(false);
		expect(
			beforeSubmitPrompt.some(
				(entry) => entry.command === "/usr/local/bin/custom-hook Start",
			),
		).toBe(true);
		expect(Array.isArray(parsed.hooks.stop)).toBe(true);
		expect(Array.isArray(parsed.hooks.beforeShellExecution)).toBe(true);
		expect(Array.isArray(parsed.hooks.beforeMCPExecution)).toBe(true);
		expect(JSON.parse(content2)).toEqual(JSON.parse(content));
	});

	it.skipIf(process.platform === "win32")("replaces stale Gemini hook commands from old superset paths", () => {
		const geminiSettingsPath = path.join(
			mockedHomeDir,
			".gemini",
			"settings.json",
		);
		const staleHookPath = "/tmp/.ade-old/hooks/gemini-hook.sh";
		const currentHookPath = "/tmp/.ade-new/hooks/gemini-hook.sh";

		mkdirSync(path.dirname(geminiSettingsPath), { recursive: true });
		writeFileSync(
			geminiSettingsPath,
			JSON.stringify(
				{
					hooks: {
						BeforeAgent: [
							{
								hooks: [{ type: "command", command: staleHookPath }],
							},
							{
								hooks: [{ type: "command", command: "/opt/custom-hook.sh" }],
							},
						],
						AfterAgent: [
							{
								hooks: [{ type: "command", command: staleHookPath }],
							},
						],
						AfterTool: [
							{
								hooks: [{ type: "command", command: staleHookPath }],
							},
						],
					},
				},
				null,
				2,
			),
		);

		const content = getGeminiSettingsJsonContent(currentHookPath);
		writeFileSync(geminiSettingsPath, content);
		const content2 = getGeminiSettingsJsonContent(currentHookPath);

		const parsed = JSON.parse(content) as {
			hooks: Record<
				string,
				Array<{ hooks: Array<{ type: string; command: string }> }>
			>;
		};
		const parsed2 = JSON.parse(content2) as {
			hooks: Record<
				string,
				Array<{ hooks: Array<{ type: string; command: string }> }>
			>;
		};

		const eventNames = ["BeforeAgent", "AfterAgent", "AfterTool"] as const;

		for (const eventName of eventNames) {
			const hooks = parsed.hooks[eventName];
			expect(Array.isArray(hooks)).toBe(true);
			expect(
				hooks.some(
					(def) =>
						def.hooks?.length === 1 &&
						def.hooks[0]?.command === currentHookPath,
				),
			).toBe(true);
			expect(
				hooks.some((def) =>
					def.hooks.some((hook) => hook.command.includes(staleHookPath)),
				),
			).toBe(false);
		}

		const beforeAgent = parsed.hooks.BeforeAgent;
		expect(
			beforeAgent.some((def) =>
				def.hooks.some((hook) => hook.command === "/opt/custom-hook.sh"),
			),
		).toBe(true);

		for (const eventName of eventNames) {
			const hooks = parsed2.hooks[eventName];
			expect(Array.isArray(hooks)).toBe(true);
			expect(
				hooks.some(
					(def) =>
						def.hooks?.length === 1 &&
						def.hooks[0]?.command === currentHookPath,
				),
			).toBe(true);
			expect(
				hooks.some((def) =>
					def.hooks.some((hook) => hook.command.includes(staleHookPath)),
				),
			).toBe(false);
		}
		expect(
			parsed2.hooks.BeforeAgent.some((def) =>
				def.hooks.some((hook) => hook.command === "/opt/custom-hook.sh"),
			),
		).toBe(true);
		expect(JSON.parse(content2)).toEqual(JSON.parse(content));
	});

	it("wires Claude Code hooks to a quiet notify command (no stdout/stderr leakage)", () => {
		const notifyPath = path.join(TEST_HOOKS_DIR, "notify.sh");
		const isWindows = process.platform === "win32";
		const baseCommand = isWindows ? `node "${notifyPath}"` : `"${notifyPath}"`;
		const content = getClaudeSettingsContent(baseCommand);
		const parsed = JSON.parse(content) as {
			hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
		};

		// Derived from the module's own event table, so a spec event added there
		// is automatically covered here rather than needing this list edited.
		const events = Object.keys(CLAUDE_HOOK_EVENTS);
		expect(events.length).toBeGreaterThan(0);

		for (const eventName of events) {
			const entries = parsed.hooks[eventName];
			expect(Array.isArray(entries)).toBe(true);
			const command = entries?.[0]?.hooks?.[0]?.command;
			// The command must redirect both stdout and stderr away from the
			// PTY/transcript so the hook is side-effect-only.
			expect(command).toBe(
				isWindows
					? `${baseCommand} >NUL 2>&1`
					: `${baseCommand} >/dev/null 2>&1`,
			);
			expect(command).toContain("2>&1");
		}
	});

	it("registers the full Mission Control event set", () => {
		const parsed = JSON.parse(getClaudeSettingsContent('"/tmp/notify.sh"')) as {
			hooks: Record<string, unknown[]>;
		};
		// The states are what session tracking reads; the names are the contract
		// with Claude Code. Both live in one table so they cannot drift apart.
		expect(CLAUDE_HOOK_EVENTS.SessionStart).toBe("idle");
		expect(CLAUDE_HOOK_EVENTS.PreToolUse).toBe("working");
		expect(CLAUDE_HOOK_EVENTS.Notification).toBe("needsInput");
		expect(CLAUDE_HOOK_EVENTS.SessionEnd).toBe("ended");

		for (const name of [
			"SessionStart",
			"PreToolUse",
			"Notification",
			"SessionEnd",
		]) {
			expect(Array.isArray(parsed.hooks[name])).toBe(true);
		}
	});

	it("scopes only tool events with a matcher", () => {
		const parsed = JSON.parse(getClaudeSettingsContent('"/tmp/notify.sh"')) as {
			hooks: Record<string, Array<{ matcher?: string }>>;
		};
		expect(parsed.hooks.PostToolUse?.[0]?.matcher).toBe("*");
		// A session-lifecycle event has no tool to match on.
		expect(parsed.hooks.SessionStart?.[0]?.matcher).toBeUndefined();
		expect(parsed.hooks.Stop?.[0]?.matcher).toBeUndefined();
	});

	describe("readClaudeHookCoverage", () => {
		it("reports what the file on disk actually registers", () => {
			const file = path.join(TEST_HOOKS_DIR, "coverage-partial.json");
			writeFileSync(
				file,
				JSON.stringify({
					hooks: {
						Stop: [{ hooks: [] }],
						SessionStart: [],
						UserPromptSubmit: [{ hooks: [{ type: "command", command: "x" }] }],
					},
				}),
			);
			const coverage = readClaudeHookCoverage(file);

			expect(coverage.present).toBe(true);
			// An empty array is not coverage — SessionStart is registered with no
			// entries, so it is reported missing.
			expect(coverage.registered.sort()).toEqual(["Stop", "UserPromptSubmit"]);
			expect(coverage.missing).toContain("SessionStart");
			expect(coverage.missing).toContain("SessionEnd");
		});

		it("reports a missing file as no coverage rather than throwing", () => {
			const coverage = readClaudeHookCoverage(
				path.join(TEST_HOOKS_DIR, "does-not-exist.json"),
			);
			expect(coverage.present).toBe(false);
			expect(coverage.registered).toEqual([]);
			expect(coverage.missing.length).toBe(
				Object.keys(CLAUDE_HOOK_EVENTS).length,
			);
		});

		it("reports an unparseable file as no coverage", () => {
			const file = path.join(TEST_HOOKS_DIR, "broken.json");
			writeFileSync(file, "{not json");
			expect(readClaudeHookCoverage(file).present).toBe(false);
		});

		it("sees full coverage in the file this module writes", () => {
			const file = path.join(TEST_HOOKS_DIR, "written.json");
			writeFileSync(file, getClaudeSettingsContent('"/tmp/notify.sh"'));
			expect(readClaudeHookCoverage(file).missing).toEqual([]);
		});
	});

	describe("backupClaudeSettings", () => {
		it("copies the old content aside when the content changes", () => {
			const file = path.join(TEST_HOOKS_DIR, "backup-me.json");
			writeFileSync(file, '{"hooks":{"Stop":[]}}');

			const backupPath = backupClaudeSettings(
				file,
				'{"hooks":{"Stop":[],"SessionEnd":[]}}',
				new Date("2026-08-09T12:34:56.000Z"),
			);

			expect(backupPath).toBe(`${file}.2026-08-09T12-34-56-000Z.bak`);
			expect(readFileSync(backupPath as string, "utf-8")).toBe(
				'{"hooks":{"Stop":[]}}',
			);
			// The original is untouched — writing the new content is the caller's job.
			expect(readFileSync(file, "utf-8")).toBe('{"hooks":{"Stop":[]}}');
		});

		it("writes no backup when the content is identical", () => {
			const file = path.join(TEST_HOOKS_DIR, "unchanged.json");
			writeFileSync(file, "same");
			expect(backupClaudeSettings(file, "same")).toBeNull();
		});

		it("writes no backup when there is no file yet", () => {
			expect(
				backupClaudeSettings(path.join(TEST_HOOKS_DIR, "absent.json"), "new"),
			).toBeNull();
		});
	});

	it.skipIf(process.platform === "win32")("replaces stale Mastra hook commands from old superset paths", () => {
		const mastraHooksPath = path.join(
			mockedHomeDir,
			".mastracode",
			"hooks.json",
		);
		const staleHookPath = "/tmp/.ade-old/hooks/notify.sh";
		const currentHookPath = "/tmp/.ade-new/hooks/notify.sh";

		mkdirSync(path.dirname(mastraHooksPath), { recursive: true });
		writeFileSync(
			mastraHooksPath,
			JSON.stringify(
				{
					UserPromptSubmit: [
						{ type: "command", command: `bash '${staleHookPath}'` },
						{ type: "command", command: "/usr/local/bin/custom-hook" },
					],
					Stop: [{ type: "command", command: `bash '${staleHookPath}'` }],
					PostToolUse: [
						{ type: "command", command: `bash '${staleHookPath}'` },
					],
				},
				null,
				2,
			),
		);

		const content = getMastraHooksJsonContent(currentHookPath);
		writeFileSync(mastraHooksPath, content);
		const content2 = getMastraHooksJsonContent(currentHookPath);

		const parsed = JSON.parse(content) as Record<
			string,
			Array<{ type: string; command: string }>
		>;
		const managedEvents = ["UserPromptSubmit", "Stop", "PostToolUse"] as const;

		for (const eventName of managedEvents) {
			const hooks = parsed[eventName];
			expect(Array.isArray(hooks)).toBe(true);
			expect(
				hooks.some(
					(entry) =>
						entry.type === "command" &&
						entry.command === `bash '${currentHookPath}'`,
				),
			).toBe(true);
			expect(hooks.some((entry) => entry.command.includes(staleHookPath))).toBe(
				false,
			);
		}

		expect(
			parsed.UserPromptSubmit.some(
				(entry) => entry.command === "/usr/local/bin/custom-hook",
			),
		).toBe(true);
		expect(JSON.parse(content2)).toEqual(JSON.parse(content));
	});
});
