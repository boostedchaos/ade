import { describe, expect, it } from "bun:test";
import {
	buildAgentPromptCommand,
	buildAgentSessionCommands,
	getAgentPresetCommands,
	isClaudeFamilyRuntime,
} from "./agent-command";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("buildAgentPromptCommand (posix)", () => {
	it("adds `--` before codex prompt payload", () => {
		const command = buildAgentPromptCommand({
			prompt: "- Only modified file: runtime.ts",
			randomId: "1234-5678",
			agent: "codex",
			windows: false,
		});

		expect(command).toContain(
			"--sandbox danger-full-access -- \"$(cat <<'SUPERSET_PROMPT_12345678'",
		);
		expect(command).toContain("- Only modified file: runtime.ts");
	});

	it("does not change non-codex commands", () => {
		const command = buildAgentPromptCommand({
			prompt: "hello",
			randomId: "abcd-efgh",
			agent: "claude",
			windows: false,
		});

		expect(command).toStartWith(
			"claude --dangerously-skip-permissions \"$(cat <<'SUPERSET_PROMPT_abcdefgh'",
		);
	});

	it("prefixes OpenRouter runtimes with posix env assignments", () => {
		const command = buildAgentPromptCommand({
			prompt: "hello",
			randomId: "abcd-efgh",
			agent: "kimi",
			windows: false,
		});

		expect(command).toStartWith(
			'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" claude --model moonshotai/kimi-k2.7-code',
		);
		expect(command).toContain("$(cat <<'");
	});
});

describe("buildAgentPromptCommand (windows)", () => {
	it("uses a PowerShell here-string instead of a heredoc", () => {
		const command = buildAgentPromptCommand({
			prompt: "hello\nworld",
			randomId: "abcd-efgh",
			agent: "claude",
			windows: true,
		});

		expect(command).toBe(
			"$__adePrompt = @'\nhello\nworld\n'@\nclaude --dangerously-skip-permissions $__adePrompt",
		);
		expect(command).not.toContain("$(cat");
	});

	it("keeps the copilot suffix after the prompt argument", () => {
		const command = buildAgentPromptCommand({
			prompt: "hello",
			randomId: "abcd-efgh",
			agent: "copilot",
			windows: true,
		});

		expect(command).toEndWith("copilot -i $__adePrompt --yolo");
	});

	it("sets OpenRouter env via $env: statements", () => {
		const command = buildAgentPromptCommand({
			prompt: "hello",
			randomId: "abcd-efgh",
			agent: "glm",
			windows: true,
		});

		expect(command).toContain(
			'$env:ANTHROPIC_BASE_URL="https://openrouter.ai/api"; $env:ANTHROPIC_AUTH_TOKEN=$env:OPENROUTER_API_KEY; $env:ANTHROPIC_API_KEY=""; claude --model z-ai/glm-5.2',
		);
		expect(command).not.toContain('ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"');
	});
});

describe("getAgentPresetCommands", () => {
	it("posix OpenRouter presets use env-prefix syntax", () => {
		const commands = getAgentPresetCommands(false);
		expect(commands.kimi[0]).toStartWith('ANTHROPIC_BASE_URL="https://');
		expect(commands.minimax[0]).toContain(
			'ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY"',
		);
	});

	it("windows OpenRouter presets use $env: statements and no posix prefix", () => {
		const commands = getAgentPresetCommands(true);
		for (const agent of ["kimi", "minimax", "glm"] as const) {
			expect(commands[agent][0]).toStartWith('$env:ANTHROPIC_BASE_URL=');
			expect(commands[agent][0]).toContain(
				"$env:ANTHROPIC_AUTH_TOKEN=$env:OPENROUTER_API_KEY",
			);
			expect(commands[agent][0]).toEndWith("--dangerously-skip-permissions");
		}
	});

	it("non-OpenRouter presets are identical across platforms", () => {
		const posix = getAgentPresetCommands(false);
		const windows = getAgentPresetCommands(true);
		for (const agent of [
			"claude",
			"codex",
			"gemini",
			"opencode",
			"copilot",
			"cursor-agent",
		] as const) {
			expect(windows[agent]).toEqual(posix[agent]);
		}
	});
});

describe("buildAgentSessionCommands", () => {
	it("injects --resume <id> for claude when a session exists", () => {
		expect(
			buildAgentSessionCommands({ runtime: "claude", sessionId: SESSION_ID }),
		).toEqual([`claude --resume ${SESSION_ID} --dangerously-skip-permissions`]);
	});

	it("injects --resume after `claude` for OpenRouter (glm) variants", () => {
		const [command] = buildAgentSessionCommands({
			runtime: "glm",
			sessionId: SESSION_ID,
		});
		if (command === undefined) throw new Error("expected a glm command");
		// Env assignments stay in front; --resume lands right after `claude`,
		// before the --model flag, so both the resume target and model apply.
		expect(command).toContain(`claude --resume ${SESSION_ID} --model`);
		expect(command).toStartWith('ANTHROPIC_BASE_URL="https://openrouter.ai/api"');
		// Exactly one resume flag (regex replaces only the first `claude` token).
		expect(command.match(/--resume/g)).toHaveLength(1);
	});

	it("starts fresh (base command) when there is no session id", () => {
		expect(
			buildAgentSessionCommands({ runtime: "claude", sessionId: null }),
		).toEqual(["claude --dangerously-skip-permissions"]);
	});

	it("never resumes a non-claude runtime even with a session id", () => {
		const commands = buildAgentSessionCommands({
			runtime: "codex",
			sessionId: SESSION_ID,
		});
		expect(commands.join(" ")).not.toContain("--resume");
	});

	it("ignores a malformed (non-UUID) session id", () => {
		expect(
			buildAgentSessionCommands({
				runtime: "claude",
				sessionId: "not-a-uuid; rm -rf /",
			}),
		).toEqual(["claude --dangerously-skip-permissions"]);
	});

	it("classifies claude-family runtimes", () => {
		expect(isClaudeFamilyRuntime("claude")).toBe(true);
		expect(isClaudeFamilyRuntime("glm")).toBe(true);
		expect(isClaudeFamilyRuntime("codex")).toBe(false);
		expect(isClaudeFamilyRuntime("gemini")).toBe(false);
	});
});
