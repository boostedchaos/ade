import fs from "node:fs";
import path from "node:path";
import {
	type AgentBinary,
	BINARY_INSTALL,
	type BinaryInstallInfo,
} from "@superset/shared/agent-binaries";
import { BIN_DIR, HOOKS_DIR } from "./paths";

export const WRAPPER_MARKER = "# ADE agent-wrapper v2";

export const IS_WINDOWS = process.platform === "win32";

/**
 * Header text embedded in every generated Windows shim (.cmd/.ps1). It contains
 * the "agent-wrapper" needle so the shim runtime's resolver skips foreign ADE /
 * Damon shims on PATH, exactly as the POSIX resolver skips bash wrappers.
 */
export const WINDOWS_SHIM_MARKER = "ADE agent-wrapper v2 (win shim)";

const SHIM_RUNTIME_NAME = "agent-shim.mjs";

const AGENT_SHIM_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"agent-shim.template.mjs",
);

/**
 * Marker substring present in every agent-wrapper header (ADE's own wrappers and
 * the user's Damon install both use "... agent-wrapper ..."). find_real_binary
 * skips any candidate whose header contains it, so a wrapper never resolves to
 * another wrapper.
 */
const WRAPPER_HEADER_NEEDLE = "agent-wrapper";

// Matches ADE-managed hook paths under the app home dir (~/.ade or
// ~/.ade-<workspace>). MUST be ADE's own dir, not ~/.damon — otherwise ADE would
// treat the user's real Damon install's hooks as its own and clobber them, and
// fail to recognize (so would duplicate) its own hooks in shared agent settings.
const SUPERSET_MANAGED_HOOK_PATH_PATTERN = /\/\.ade(?:-[^/'"\s\\]+)?\//;

export function writeFileIfChanged(
	filePath: string,
	content: string,
	mode: number,
): boolean {
	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf-8")
		: null;
	if (existing === content) {
		try {
			fs.chmodSync(filePath, mode);
		} catch {
			// Best effort.
		}
		return false;
	}

	fs.writeFileSync(filePath, content, { mode });
	return true;
}

export function isSupersetManagedHookCommand(
	command: string | undefined,
	scriptName: string,
): boolean {
	if (!command) return false;
	const normalized = command.replaceAll("\\", "/");
	if (!normalized.includes(`/hooks/${scriptName}`)) return false;
	return SUPERSET_MANAGED_HOOK_PATH_PATTERN.test(normalized);
}

function buildRealBinaryResolver(): string {
	return `find_real_binary() {
  local name="$1"
  local IFS=:
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    dir="\${dir%/}"
    case "$dir" in
      "${BIN_DIR}"|"$HOME"/.ade/bin|"$HOME"/.ade-*/bin) continue ;;
    esac
    local candidate="$dir/$name"
    if [ -x "$candidate" ] && [ ! -d "$candidate" ]; then
      # Skip other agent-wrapper shims (another ADE wrapper on PATH, or the
      # user's Damon install) so we resolve the real binary directly. Chaining
      # wrappers ping-pongs and keeps prepending --settings, which breaks the
      # CLI's interactive TUI.
      if head -c 512 "$candidate" 2>/dev/null | grep -qa "${WRAPPER_HEADER_NEEDLE}"; then
        continue
      fi
      printf "%s\\n" "$candidate"
      return 0
    fi
  done
  return 1
}
`;
}

function getMissingBinaryMessage(name: string): string {
	// Enrich with the per-tool install command + URL so the terminal fallback is
	// self-explanatory. Embedded inside a bash double-quoted echo, so the message
	// must stay on one line and avoid double quotes / $ / backticks (install
	// commands and URLs contain none).
	const info = BINARY_INSTALL[name as AgentBinary];
	if (info) {
		return `ADE: ${name} not found on PATH. Install ${info.label}: ${info.command} — ${info.url}`;
	}
	return `ADE: ${name} not found in PATH. Install it and ensure it is on PATH, then retry.`;
}

export function getWrapperPath(binaryName: string): string {
	return path.join(BIN_DIR, binaryName);
}

export function getShimRuntimePath(): string {
	return path.join(HOOKS_DIR, SHIM_RUNTIME_NAME);
}

/**
 * A hook command that runs a ported `.mjs` script via node, with Windows-safe
 * quoting. Windows agent hook configs (Claude settings.json, cursor hooks.json,
 * etc.) cannot exec a `.sh` file, so on win32 every hook command is `node "<abs
 * path>.mjs" [arg]`. Windows paths never contain a double quote, so wrapping the
 * path in double quotes is sufficient.
 */
export function nodeHookCommand(scriptPath: string, arg?: string): string {
	const base = `node "${scriptPath}"`;
	return arg ? `${base} ${arg}` : base;
}

/** Escape a path for embedding inside a single-quoted PowerShell string. */
function escapePs1SingleQuoted(value: string): string {
	return value.replaceAll("'", "''");
}

function buildCmdShim(binaryName: string, shimPath: string): string {
	// `%` must be doubled inside a batch file; `%*` forwards every arg. node is an
	// .exe (no `call` needed) and its exit code becomes the script's exit code.
	const safeShimPath = shimPath.replaceAll("%", "%%");
	return [
		"@echo off",
		`REM ${WINDOWS_SHIM_MARKER}`,
		`node "${safeShimPath}" ${binaryName} %*`,
		"",
	].join("\r\n");
}

function buildPs1Shim(binaryName: string, shimPath: string): string {
	// Single-quote the path so PowerShell does not interpolate `$`; `@args`
	// splats every argument through to node; propagate the child's exit code.
	return [
		`# ${WINDOWS_SHIM_MARKER}`,
		`& node '${escapePs1SingleQuoted(shimPath)}' ${binaryName} @args`,
		"exit $LASTEXITCODE",
		"",
	].join("\r\n");
}

/**
 * Windows interception: instead of a POSIX bash wrapper + shell-function shim,
 * every agent gets `<name>.cmd` and `<name>.ps1` on the PATH-prepended BIN_DIR.
 * Both delegate to the shared node launcher (agent-shim.mjs), which resolves the
 * real binary, applies the agent's env/args, and execs it. See the divergence
 * note in the E2 report for why resolution lives in node rather than in the
 * .cmd/.ps1 directly.
 */
export function createWindowsShim(binaryName: string): void {
	const shimPath = getShimRuntimePath();
	const wroteCmd = writeFileIfChanged(
		path.join(BIN_DIR, `${binaryName}.cmd`),
		buildCmdShim(binaryName, shimPath),
		0o755,
	);
	const wrotePs1 = writeFileIfChanged(
		path.join(BIN_DIR, `${binaryName}.ps1`),
		buildPs1Shim(binaryName, shimPath),
		0o755,
	);
	console.log(
		`[agent-setup] ${
			wroteCmd || wrotePs1 ? "Updated" : "Verified"
		} ${binaryName} Windows shim`,
	);
}

export interface ShimRuntimeAgentConfig {
	extraArgs?: string[];
	env?: Record<string, string>;
	codexWatcher?: boolean;
	copilotInject?: {
		hookMjs: string;
		hooksJson: unknown;
	};
}

export interface ShimRuntimeConfig {
	binDir: string;
	notifyMjs: string;
	// Keyed by agent binary name (the shim looks up by the invoked name, which
	// includes non-AgentBinary names like "cursor-agent" that resolve to
	// undefined -> generic message). BINARY_INSTALL is assignable to this.
	installInfo: Record<string, BinaryInstallInfo>;
	agents: Record<string, ShimRuntimeAgentConfig>;
}

/**
 * Writes the shared Windows launcher (agent-shim.mjs) with its per-agent config
 * baked in, mirroring how the `.template.sh` files substitute placeholders.
 */
export function createShimRuntime(config: ShimRuntimeConfig): void {
	const template = fs.readFileSync(AGENT_SHIM_TEMPLATE_PATH, "utf-8");
	const content = template
		.replace("{{MARKER}}", `// ${WINDOWS_SHIM_MARKER}`)
		.replace("{{CONFIG}}", JSON.stringify(config, null, 2));
	const changed = writeFileIfChanged(getShimRuntimePath(), content, 0o755);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} Windows agent-shim runtime`,
	);
}

export function buildWrapperScript(
	binaryName: string,
	execLine: string,
): string {
	return `#!/bin/bash
${WRAPPER_MARKER}
# ADE wrapper for ${binaryName}

${buildRealBinaryResolver()}
REAL_BIN="$(find_real_binary "${binaryName}")"
if [ -z "$REAL_BIN" ]; then
  echo "${getMissingBinaryMessage(binaryName)}" >&2
  exit 127
fi

${execLine}
`;
}

export function createWrapper(binaryName: string, script: string): void {
	// On Windows the bash `script` is inapplicable; interception is done with
	// PATH-prepended .cmd/.ps1 shims that delegate to the shared node launcher.
	if (IS_WINDOWS) {
		createWindowsShim(binaryName);
		return;
	}
	const changed = writeFileIfChanged(getWrapperPath(binaryName), script, 0o755);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} ${binaryName} wrapper`,
	);
}
