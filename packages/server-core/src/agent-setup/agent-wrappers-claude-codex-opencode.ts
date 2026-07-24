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

export function getClaudeSettingsContent(notifyCommand: string): string {
	const command = quietNotifyCommand(notifyCommand);
	const settings = {
		hooks: {
			UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
			Stop: [{ hooks: [{ type: "command", command }] }],
			PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }],
			PostToolUseFailure: [
				{ matcher: "*", hooks: [{ type: "command", command }] },
			],
			PermissionRequest: [
				{ matcher: "*", hooks: [{ type: "command", command }] },
			],
		},
	};

	return JSON.stringify(settings);
}

export function getOpenCodePluginContent(notifyPath: string): string {
	const template = fs.readFileSync(OPENCODE_PLUGIN_TEMPLATE_PATH, "utf-8");
	// On Windows the notify hook is a .mjs run via node; POSIX runs the .sh via bash.
	const notifyRunner = IS_WINDOWS ? "node" : "bash";
	return template
		.replace("{{MARKER}}", OPENCODE_PLUGIN_MARKER)
		.replace("{{NOTIFY_RUNNER}}", notifyRunner)
		// JSON.stringify → a properly-escaped JS string literal, so Windows
		// backslashes in the path can't be misread as JS escape sequences.
		.replace("{{NOTIFY_PATH_JSON}}", JSON.stringify(notifyPath));
}

function createClaudeSettings(): string {
	const settingsPath = getClaudeSettingsPath();
	const notifyPath = getNotifyScriptPath();
	// On Windows the hook is a .mjs that Claude must run via node.
	const notifyCommand = IS_WINDOWS
		? nodeHookCommand(notifyPath)
		: `"${notifyPath}"`;
	const settings = getClaudeSettingsContent(notifyCommand);

	writeFileIfChanged(settingsPath, settings, 0o644);
	return settingsPath;
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
