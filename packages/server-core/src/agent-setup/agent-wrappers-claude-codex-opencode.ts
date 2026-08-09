import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildWrapperScript,
	createWrapper,
	IS_WINDOWS,
	nodeHookCommand,
	writeFileIfChanged,
} from "./agent-wrappers-common";
import { getNotifyScriptPath } from "./notify-hook";
import { HOOKS_DIR, OPENCODE_CONFIG_DIR, OPENCODE_PLUGIN_DIR } from "./paths";

export const CLAUDE_SETTINGS_FILE = "claude-settings.json";
export const OPENCODE_PLUGIN_FILE = "superset-notify.js";

const OPENCODE_PLUGIN_SIGNATURE = "// Superset opencode plugin";
const OPENCODE_PLUGIN_VERSION = "v8";
export const OPENCODE_PLUGIN_MARKER = `${OPENCODE_PLUGIN_SIGNATURE} ${OPENCODE_PLUGIN_VERSION}`;

const OPENCODE_PLUGIN_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"opencode-plugin.template.js",
);
const CODEX_WRAPPER_EXEC_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"codex-wrapper-exec.template.sh",
);

export function getClaudeSettingsPath(): string {
	return path.join(HOOKS_DIR, CLAUDE_SETTINGS_FILE);
}

export function getOpenCodePluginPath(): string {
	return path.join(OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN_FILE);
}

/** @see https://opencode.ai/docs/plugins */
export function getOpenCodeGlobalPluginPath(): string {
	const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
	const configHome = xdgConfigHome?.length
		? xdgConfigHome
		: path.join(os.homedir(), ".config");
	return path.join(configHome, "opencode", "plugin", OPENCODE_PLUGIN_FILE);
}

/**
 * Wraps the notify invocation so it is side-effect-only: stdout/stderr are
 * redirected away from the PTY/transcript, leaving only the out-of-band
 * HTTP notification. Without this, Claude Code can surface a hook's output
 * in the terminal/transcript — and for UserPromptSubmit specifically, stdout
 * gets injected back into the conversation as context — which is exactly the
 * "dirtied conversation" behavior this hook must avoid. Mirrors the same
 * `>/dev/null 2>&1` convention already used for this script by the Codex
 * wrapper (see codex-wrapper-exec.template.sh). The base command must
 * already be platform-appropriate (node .mjs on Windows, script path on
 * POSIX); the redirection syntax below works in both cmd.exe and sh.
 */
export function quietNotifyCommand(baseCommand: string): string {
	return IS_WINDOWS
		? `${baseCommand} >NUL 2>&1`
		: `${baseCommand} >/dev/null 2>&1`;
}

/**
 * Claude Code hook events ADE registers, and the AgentSession state each one
 * means. The state column is not written into the settings file — Claude only
 * needs the event names — but it is the checked contract that this file covers
 * the whole spec event set (Mission Control SPEC Feature 2). `hooks status`
 * reports coverage against these names.
 *
 * `PreToolUse` is `working`, not a permission prompt: Claude fires it for every
 * tool call, permitted or not. The needsInput signal is `Notification` /
 * `PermissionRequest`.
 */
export const CLAUDE_HOOK_EVENTS = {
	SessionStart: "idle",
	UserPromptSubmit: "working",
	PreToolUse: "working",
	PostToolUse: "working",
	PostToolUseFailure: "working",
	Notification: "needsInput",
	PermissionRequest: "needsInput",
	Stop: "idle",
	SessionEnd: "ended",
} as const;

export type ClaudeHookEventName = keyof typeof CLAUDE_HOOK_EVENTS;

/** Events Claude Code scopes by tool name; the rest take no matcher. */
const MATCHER_EVENTS = new Set<ClaudeHookEventName>([
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PermissionRequest",
]);

export function getClaudeSettingsContent(notifyCommand: string): string {
	const command = quietNotifyCommand(notifyCommand);
	const hooks: Record<string, unknown[]> = {};
	for (const eventName of Object.keys(
		CLAUDE_HOOK_EVENTS,
	) as ClaudeHookEventName[]) {
		hooks[eventName] = MATCHER_EVENTS.has(eventName)
			? [{ matcher: "*", hooks: [{ type: "command", command }] }]
			: [{ hooks: [{ type: "command", command }] }];
	}

	return JSON.stringify({ hooks });
}

export function getOpenCodePluginContent(notifyPath: string): string {
	const template = fs.readFileSync(OPENCODE_PLUGIN_TEMPLATE_PATH, "utf-8");
	// On Windows the notify hook is a .mjs run via node; POSIX runs the .sh via bash.
	const notifyRunner = IS_WINDOWS ? "node" : "bash";
	return (
		template
			.replace("{{MARKER}}", OPENCODE_PLUGIN_MARKER)
			.replace("{{NOTIFY_RUNNER}}", notifyRunner)
			// JSON.stringify → a properly-escaped JS string literal, so Windows
			// backslashes in the path can't be misread as JS escape sequences.
			.replace("{{NOTIFY_PATH_JSON}}", JSON.stringify(notifyPath))
	);
}

/**
 * Which of the spec's events the file on disk actually registers. Backs
 * `ade hooks status`, so a hooks file left over from an older ADE reports its
 * real gaps instead of the gaps the current code would have written.
 */
export function readClaudeHookCoverage(
	settingsPath = getClaudeSettingsPath(),
): {
	present: boolean;
	registered: ClaudeHookEventName[];
	missing: ClaudeHookEventName[];
} {
	const expected = Object.keys(CLAUDE_HOOK_EVENTS) as ClaudeHookEventName[];
	let registered: ClaudeHookEventName[] = [];
	let present = false;
	try {
		const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
			hooks?: Record<string, unknown>;
		};
		present = true;
		const hooks = parsed.hooks ?? {};
		registered = expected.filter(
			(name) => Array.isArray(hooks[name]) && (hooks[name] as unknown[]).length,
		);
	} catch {
		// Missing or unparseable — both are "no coverage", and the caller only
		// needs to know which events are not wired.
	}
	return {
		present,
		registered,
		missing: expected.filter((name) => !registered.includes(name)),
	};
}

/**
 * Copies the current hooks file aside before it is overwritten with different
 * content. This is ADE's own file, not ~/.claude/settings.json (see PROTOCOL.md
 * "Feature 2 amendment"), but the spec's back-up-what-you-edit rule applies to
 * it just the same — the previous file is the only way back if a hook change
 * breaks an agent mid-run. Returns the backup path, or null if nothing needed
 * backing up.
 */
export function backupClaudeSettings(
	settingsPath: string,
	nextContent: string,
	now = new Date(),
): string | null {
	let existing: string;
	try {
		existing = fs.readFileSync(settingsPath, "utf-8");
	} catch {
		return null;
	}
	if (existing === nextContent) return null;

	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const backupPath = `${settingsPath}.${stamp}.bak`;
	fs.writeFileSync(backupPath, existing, { mode: 0o644 });
	return backupPath;
}

export interface ClaudeSettingsWriteResult {
	settingsPath: string;
	changed: boolean;
	/** Set only when an existing file with different content was replaced. */
	backupPath: string | null;
}

export function writeClaudeSettings(): ClaudeSettingsWriteResult {
	const settingsPath = getClaudeSettingsPath();
	const notifyPath = getNotifyScriptPath();
	// On Windows the hook is a .mjs that Claude must run via node.
	const notifyCommand = IS_WINDOWS
		? nodeHookCommand(notifyPath)
		: `"${notifyPath}"`;
	const settings = getClaudeSettingsContent(notifyCommand);

	const backupPath = backupClaudeSettings(settingsPath, settings);
	const changed = writeFileIfChanged(settingsPath, settings, 0o644);
	if (backupPath) {
		console.log(
			`[agent-setup] Previous claude hooks file saved: ${backupPath}`,
		);
	}
	return { settingsPath, changed, backupPath };
}

function createClaudeSettings(): string {
	return writeClaudeSettings().settingsPath;
}

export function createClaudeWrapper(): void {
	const settingsPath = createClaudeSettings();
	const script = buildWrapperScript(
		"claude",
		`exec "$REAL_BIN" --settings "${settingsPath}" "$@"`,
	);
	createWrapper("claude", script);
}

export function createCodexWrapper(): void {
	const notifyPath = getNotifyScriptPath();
	const script = buildWrapperScript(
		"codex",
		buildCodexWrapperExecLine(notifyPath),
	);
	createWrapper("codex", script);
}

export function buildCodexWrapperExecLine(notifyPath: string): string {
	const template = fs.readFileSync(CODEX_WRAPPER_EXEC_TEMPLATE_PATH, "utf-8");
	return template.replaceAll("{{NOTIFY_PATH}}", notifyPath);
}

/**
 * Writes to environment-specific path only, NOT the global path.
 * Global path causes dev/prod conflicts when both are running.
 */
export function createOpenCodePlugin(): void {
	const pluginPath = getOpenCodePluginPath();
	const notifyPath = getNotifyScriptPath();
	const content = getOpenCodePluginContent(notifyPath);
	const changed = writeFileIfChanged(pluginPath, content, 0o644);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} OpenCode plugin`,
	);
}

/**
 * Removes stale global plugin written by older versions.
 * Only removes if the file contains our signature to avoid deleting user plugins.
 */
export function cleanupGlobalOpenCodePlugin(): void {
	try {
		const globalPluginPath = getOpenCodeGlobalPluginPath();
		if (!fs.existsSync(globalPluginPath)) return;

		const content = fs.readFileSync(globalPluginPath, "utf-8");
		if (content.includes(OPENCODE_PLUGIN_SIGNATURE)) {
			fs.unlinkSync(globalPluginPath);
			console.log(
				"[agent-setup] Removed stale global OpenCode plugin to prevent dev/prod conflicts",
			);
		}
	} catch (error) {
		console.warn(
			"[agent-setup] Failed to cleanup global OpenCode plugin:",
			error,
		);
	}
}

export function createOpenCodeWrapper(): void {
	const script = buildWrapperScript(
		"opencode",
		`export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR}"\nexec "$REAL_BIN" "$@"`,
	);
	createWrapper("opencode", script);
}
