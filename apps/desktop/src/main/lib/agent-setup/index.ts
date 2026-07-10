import fs from "node:fs";
import { BINARY_INSTALL } from "@superset/shared/agent-binaries";
import {
	cleanupGlobalOpenCodePlugin,
	createClaudeWrapper,
	createCodexWrapper,
	createCopilotHookScript,
	createCopilotWrapper,
	createCursorAgentWrapper,
	createCursorHookScript,
	createCursorHooksJson,
	createGeminiHookScript,
	createGeminiSettingsJson,
	createGeminiWrapper,
	createMastraHooksJson,
	createMastraWrapper,
	createOpenCodePlugin,
	createOpenCodeWrapper,
	getClaudeSettingsPath,
	getCopilotHookScriptPath,
	getCopilotHooksObject,
} from "./agent-wrappers";
import {
	createShimRuntime,
	type ShimRuntimeConfig,
} from "./agent-wrappers-common";
import { getNotifyScriptPath, createNotifyScript } from "./notify-hook";
import {
	BASH_DIR,
	BIN_DIR,
	HOOKS_DIR,
	OPENCODE_CONFIG_DIR,
	OPENCODE_PLUGIN_DIR,
	ZSH_DIR,
} from "./paths";
import {
	createBashWrapper,
	createZshWrapper,
	getCommandShellArgs,
	getShellArgs,
	getShellEnv,
} from "./shell-wrappers";

/**
 * Per-agent config baked into the Windows launcher (agent-shim.mjs). Mirrors the
 * side effects each POSIX bash wrapper performs: claude's --settings, codex's
 * task_started watcher + notify config, opencode's OPENCODE_CONFIG_DIR, and
 * copilot's per-repo hook injection.
 */
function buildShimRuntimeConfig(): ShimRuntimeConfig {
	const copilotHookMjs = getCopilotHookScriptPath();
	return {
		binDir: BIN_DIR,
		notifyMjs: getNotifyScriptPath(),
		installInfo: BINARY_INSTALL,
		agents: {
			claude: { extraArgs: ["--settings", getClaudeSettingsPath()] },
			codex: { codexWatcher: true },
			opencode: { env: { OPENCODE_CONFIG_DIR } },
			gemini: {},
			"cursor-agent": {},
			mastracode: {},
			copilot: {
				copilotInject: {
					hookMjs: copilotHookMjs,
					hooksJson: getCopilotHooksObject(copilotHookMjs),
				},
			},
		},
	};
}

export function setupAgentHooks(): void {
	console.log("[agent-setup] Initializing agent hooks...");

	const isWindows = process.platform === "win32";

	fs.mkdirSync(BIN_DIR, { recursive: true });
	fs.mkdirSync(HOOKS_DIR, { recursive: true });
	fs.mkdirSync(ZSH_DIR, { recursive: true });
	fs.mkdirSync(BASH_DIR, { recursive: true });
	fs.mkdirSync(OPENCODE_PLUGIN_DIR, { recursive: true });

	cleanupGlobalOpenCodePlugin();

	createNotifyScript();
	// Windows: write the shared node launcher before the .cmd/.ps1 shims that call it.
	if (isWindows) {
		createShimRuntime(buildShimRuntimeConfig());
	}
	createClaudeWrapper();
	createCodexWrapper();
	createOpenCodePlugin();
	createOpenCodeWrapper();
	createCursorHookScript();
	createCursorAgentWrapper();
	createCursorHooksJson();
	createGeminiHookScript();
	createGeminiWrapper();
	createGeminiSettingsJson();
	createMastraWrapper();
	createMastraHooksJson();
	createCopilotHookScript();
	createCopilotWrapper();

	// POSIX intercepts `claude`/`codex`/etc. via shell functions sourced from rc
	// files. Windows has no rc files: BIN_DIR is prepended to PATH in getShellEnv
	// (see shell-wrappers.ts) so the .cmd/.ps1 shims win over the real binaries.
	if (!isWindows) {
		createZshWrapper();
		createBashWrapper();
	}

	console.log("[agent-setup] Agent hooks initialized");
}

export function getSupersetBinDir(): string {
	return BIN_DIR;
}

export { getCommandShellArgs, getShellArgs, getShellEnv };
