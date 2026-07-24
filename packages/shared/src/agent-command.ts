export const AGENT_TYPES = [
	"claude",
	"codex",
	"gemini",
	"opencode",
	"copilot",
	"cursor-agent",
	"kimi",
	"minimax",
	"glm",
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_LABELS: Record<AgentType, string> = {
	claude: "Claude",
	codex: "Codex",
	gemini: "Gemini",
	opencode: "OpenCode",
	copilot: "Copilot",
	"cursor-agent": "Cursor Agent",
	kimi: "Kimi K2.7",
	minimax: "MiniMax M3",
	glm: "GLM 5.2",
};

/**
 * These command strings are written into an interactive shell's stdin, so they
 * must be valid in whatever shell the session runs: zsh/bash on POSIX,
 * PowerShell on Windows (the win32 default-shell resolution tries pwsh, then
 * powershell.exe — which always exists — before cmd.exe, so PowerShell syntax
 * is the Windows target; a COMSPEC-only cmd session is out of scope).
 *
 * This module runs in both the Electron main process and the renderer, hence
 * the dual platform probe.
 */
export const IS_WINDOWS =
	typeof process !== "undefined" && !!process.versions?.node
		? process.platform === "win32"
		: /windows/i.test(
				(globalThis as { navigator?: { userAgent?: string } }).navigator
					?.userAgent ?? "",
			);

const OPENROUTER_CLAUDE_COMMANDS = {
	kimi: "claude --model moonshotai/kimi-k2.7-code --dangerously-skip-permissions",
	minimax: "claude --model minimax/minimax-m3 --dangerously-skip-permissions",
	glm: "claude --model z-ai/glm-5.2 --dangerously-skip-permissions",
} as const satisfies Partial<Record<AgentType, string>>;

/**
 * Env prefix that points the `claude` CLI at OpenRouter. On POSIX this is the
 * usual one-shot `VAR=value command` form; PowerShell has no equivalent, so
 * there the vars are set on the session with `$env:` statements first (note:
 * assigning "" removes the variable in PowerShell, which is exactly what the
 * ANTHROPIC_API_KEY blanking wants).
 */
function openRouterEnvPrefix(windows: boolean): string {
	return windows
		? '$env:ANTHROPIC_BASE_URL="https://openrouter.ai/api"; $env:ANTHROPIC_AUTH_TOKEN=$env:OPENROUTER_API_KEY; $env:ANTHROPIC_API_KEY=""; '
		: 'ANTHROPIC_BASE_URL="https://openrouter.ai/api" ANTHROPIC_AUTH_TOKEN="$OPENROUTER_API_KEY" ANTHROPIC_API_KEY="" ';
}

/** Exported for tests; production callers use AGENT_PRESET_COMMANDS below. */
export function getAgentPresetCommands(
	windows = IS_WINDOWS,
): Record<AgentType, string[]> {
	const openRouter = (
		agent: keyof typeof OPENROUTER_CLAUDE_COMMANDS,
	): string[] => [
		`${openRouterEnvPrefix(windows)}${OPENROUTER_CLAUDE_COMMANDS[agent]}`,
	];
	return {
		claude: ["claude --dangerously-skip-permissions"],
		codex: [
			'codex --model gpt-5.5 -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access -c model_reasoning_summary="detailed" -c model_supports_reasoning_summaries=true',
		],
		gemini: ["gemini --yolo"],
		opencode: ["opencode"],
		copilot: ["copilot --allow-all"],
		"cursor-agent": ["cursor-agent"],
		kimi: openRouter("kimi"),
		minimax: openRouter("minimax"),
		glm: openRouter("glm"),
	};
}

export const AGENT_PRESET_COMMANDS: Record<AgentType, string[]> =
	getAgentPresetCommands();

/**
 * Session-id (UUID) shape Claude Code uses for its `.jsonl` transcript names.
 * Guarded here because the id is interpolated into a shell command that gets
 * typed into a PTY — only ever accept a real UUID, never arbitrary text.
 */
const CLAUDE_SESSION_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runtimes whose preset command launches the `claude` CLI — directly, or via an
 * OpenRouter base-url shim. Only these support `claude --resume <id>` and store
 * their transcripts in the worktree's `~/.claude/projects` bucket, so only these
 * can deterministically resume a prior conversation when an agent is re-opened.
 */
export const CLAUDE_FAMILY_RUNTIMES: readonly AgentType[] = [
	"claude",
	"kimi",
	"minimax",
	"glm",
];

export function isClaudeFamilyRuntime(runtime: AgentType): boolean {
	return CLAUDE_FAMILY_RUNTIMES.includes(runtime);
}

/**
 * Insert `--resume <id>` immediately after the `claude` executable token so the
 * launch continues THAT specific conversation. Matches the first bare `claude`
 * word (start-of-string or after whitespace, followed by whitespace) — the CLI
 * invocation in every claude-family preset, including the OpenRouter variants
 * where `claude` is preceded by `ANTHROPIC_*=...` env assignments.
 */
function insertResumeFlag(command: string, sessionId: string): string {
	return command.replace(
		/(^|\s)claude(?=\s)/,
		`$1claude --resume ${sessionId}`,
	);
}

/**
 * Build the terminal command(s) that launch an agent's runtime session,
 * resuming a known Claude conversation when one exists (issue #49).
 *
 * When `sessionId` is a valid Claude session UUID and the runtime is a
 * claude-family runtime, `--resume <id>` is injected so re-opening the agent
 * deterministically continues that exact conversation. Otherwise the base
 * preset command is returned unchanged — a fresh session — which is the correct
 * behaviour for a brand-new agent or a non-claude runtime.
 */
export function buildAgentSessionCommands({
	runtime,
	sessionId,
}: {
	runtime: AgentType;
	sessionId?: string | null;
}): string[] {
	const base = AGENT_PRESET_COMMANDS[runtime];
	if (
		!sessionId ||
		!isClaudeFamilyRuntime(runtime) ||
		!CLAUDE_SESSION_ID_RE.test(sessionId)
	) {
		return base;
	}
	return base.map((command) => insertResumeFlag(command, sessionId));
}

export const AGENT_PRESET_DESCRIPTIONS: Record<AgentType, string> = {
	claude: "Danger mode: All permissions auto-approved",
	codex: "Danger mode: All permissions auto-approved",
	gemini: "Danger mode: All permissions auto-approved",
	opencode: "OpenCode: Open-source AI coding agent",
	copilot: "Danger mode: All permissions auto-approved",
	"cursor-agent": "Cursor AI agent for terminal-based coding assistance",
	kimi: "Kimi K2.7 via Claude Code + OpenRouter",
	minimax: "MiniMax M3 via Claude Code + OpenRouter",
	glm: "GLM 5.2 via Claude Code + OpenRouter",
};

export interface TaskInput {
	id: string;
	slug: string;
	title: string;
	description: string | null;
	priority: string;
	statusName: string | null;
	labels: string[] | null;
}

function buildPrompt(task: TaskInput): string {
	const metadata = [
		`Priority: ${task.priority}`,
		task.statusName && `Status: ${task.statusName}`,
		task.labels?.length && `Labels: ${task.labels.join(", ")}`,
	]
		.filter(Boolean)
		.join("\n");

	return `You are working on task "${task.title}" (${task.slug}).

${metadata}

## Task Description

${task.description || "No description provided."}

## Instructions

You are running fully autonomously. Do not ask questions or wait for user feedback — make all decisions independently based on the codebase and task description.

1. Explore the codebase to understand the relevant code and architecture
2. Create a detailed execution plan for this task including:
   - Purpose and scope of the changes
   - Key assumptions
   - Concrete implementation steps with specific files to modify
   - How to validate the changes work correctly
3. Implement the plan
4. Verify your changes work correctly (run relevant tests, typecheck, lint)
5. When done, use the Superset MCP \`update_task\` tool to update task "${task.id}" with a summary of what was done`;
}

function buildHeredoc(
	prompt: string,
	delimiter: string,
	command: string,
	suffix?: string,
): string {
	const closing = suffix ? `)" ${suffix}` : ')"';
	return [
		`${command} "$(cat <<'${delimiter}'`,
		prompt,
		delimiter,
		closing,
	].join("\n");
}

/**
 * PowerShell counterpart of buildHeredoc: assign the prompt to a variable via
 * a literal here-string, then pass the variable as one argument. A here-string
 * terminates at a line beginning with '@ — a prompt containing such a line
 * would break it, same class of limitation as the POSIX heredoc delimiter.
 */
function buildPsHereString(
	prompt: string,
	command: string,
	suffix?: string,
): string {
	const invoke = suffix
		? `${command} $__adePrompt ${suffix}`
		: `${command} $__adePrompt`;
	return ["$__adePrompt = @'", prompt, "'@", invoke].join("\n");
}

interface PromptCommandSpec {
	command: string;
	suffix?: string;
	/** Prepend the OpenRouter env prefix (kimi/minimax/glm run via claude). */
	openRouter?: boolean;
}

const PROMPT_COMMANDS: Record<AgentType, PromptCommandSpec> = {
	claude: { command: "claude --dangerously-skip-permissions" },
	codex: {
		command:
			'codex --model gpt-5.5 -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access --',
	},
	gemini: { command: "gemini --yolo" },
	opencode: { command: "opencode --prompt" },
	copilot: { command: "copilot -i", suffix: "--yolo" },
	"cursor-agent": { command: "cursor-agent --yolo" },
	kimi: { command: OPENROUTER_CLAUDE_COMMANDS.kimi, openRouter: true },
	minimax: { command: OPENROUTER_CLAUDE_COMMANDS.minimax, openRouter: true },
	glm: { command: OPENROUTER_CLAUDE_COMMANDS.glm, openRouter: true },
};

export function buildAgentPromptCommand({
	prompt,
	randomId,
	agent = "claude",
	windows = IS_WINDOWS,
}: {
	prompt: string;
	randomId: string;
	agent?: AgentType;
	windows?: boolean;
}): string {
	const spec = PROMPT_COMMANDS[agent];
	const command = spec.openRouter
		? `${openRouterEnvPrefix(windows)}${spec.command}`
		: spec.command;

	if (windows) {
		return buildPsHereString(prompt, command, spec.suffix);
	}

	let delimiter = `SUPERSET_PROMPT_${randomId.replaceAll("-", "")}`;
	while (prompt.includes(delimiter)) {
		delimiter = `${delimiter}_X`;
	}
	return buildHeredoc(prompt, delimiter, command, spec.suffix);
}

export function buildAgentCommand({
	task,
	randomId,
	agent = "claude",
	windows,
}: {
	task: TaskInput;
	randomId: string;
	agent?: AgentType;
	windows?: boolean;
}): string {
	const prompt = buildPrompt(task);
	return buildAgentPromptCommand({ prompt, randomId, agent, windows });
}

/** @deprecated Use `buildAgentCommand` instead */
export function buildClaudeCommand({
	task,
	randomId,
}: {
	task: TaskInput;
	randomId: string;
}): string {
	return buildAgentCommand({ task, randomId, agent: "claude" });
}
