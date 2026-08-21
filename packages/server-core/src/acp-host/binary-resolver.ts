import { buildSafeEnv } from "../terminal/env";
import { acpError } from "./errors";

/**
 * Host-app hook: where the `claude-agent-acp` entry script lives.
 *
 * `server-core` is Electron-free by contract, so it must not know whether it
 * runs inside the desktop app or `apps/server`. The Electron app registers a
 * resolver pointing at the packaged adapter inside its resources; `apps/server`
 * and tests register one that resolves the installed package (or a fixture).
 *
 * Same shape as `terminal-host/client.ts`'s `setDaemonScriptPathResolver`.
 */
let acpBinaryPathResolver: (() => string) | null = null;

export function setAcpBinaryPathResolver(resolver: () => string): void {
	acpBinaryPathResolver = resolver;
}

/**
 * Path to the `claude-agent-acp` entry script.
 *
 * Throws `acp-binary-unresolved` — before any spawn — when no resolver has been
 * registered, so the failure names its own fix.
 */
export function getAcpBinaryPath(): string {
	if (!acpBinaryPathResolver) {
		throw acpError(
			"acp-binary-unresolved",
			"no claude-agent-acp path resolver registered. " +
				"Call setAcpBinaryPathResolver() during app bootstrap, before creating an ACP session.",
		);
	}
	return acpBinaryPathResolver();
}

/**
 * Host-app hook: the executable used to spawn the adapter script.
 *
 * Mirrors `terminal-host/client.ts`'s `setDaemonExecPathResolver`, and exists
 * for the same two reasons:
 *
 * - The desktop app spawns `process.execPath`, which is the Electron binary.
 *   Without `ELECTRON_RUN_AS_NODE=1` that child comes up as a Chromium browser
 *   process and never exits on its own, so `spawnAcpChildEnv()` sets the flag
 *   whenever the resolved exec path IS `process.execPath`.
 * - `apps/server` runs under bun, where `process.execPath` is the bun binary.
 *   It registers a resolver returning plain `"node"`, exactly like the terminal
 *   daemon does (`apps/server/src/routers/terminal.ts`).
 *
 * Unregistered is not an error here: `process.execPath` is a working default
 * for the plain-Node case, which is also what the unit suite runs under.
 */
let acpExecPathResolver: (() => string) | null = null;

export function setAcpExecPathResolver(resolver: () => string): void {
	acpExecPathResolver = resolver;
}

/** The executable to spawn the adapter under. Defaults to `process.execPath`. */
export function getAcpExecPath(): string {
	return acpExecPathResolver?.() ?? process.execPath;
}

/**
 * Environment variables that identify a pane to the HTTP hooks server.
 *
 * The agent hook templates read these (`agent-setup/templates/*.template.*`)
 * and POST them to the notifications server, which turns them into a
 * `setPaneStatus` write for that pane. The TERMINAL stack injects them
 * deliberately; the ACP stack must never carry them, because an ACP pane is
 * its own status writer (in-band, renderer-side) and a hook arriving under a
 * pane id gives that pane a second, uncoordinated writer.
 *
 * They are stripped rather than merely "not added": `buildSafeEnv` allowlists
 * the whole `SUPERSET_` PREFIX, so any of these present in the HOST process's
 * environment is inherited verbatim — which is exactly what happens when Argus
 * itself is launched from inside an Argus terminal pane.
 */
export const ACP_STRIPPED_HOOK_ENV_VARS = [
	"SUPERSET_PANE_ID",
	"SUPERSET_TAB_ID",
	"SUPERSET_WORKSPACE_ID",
] as const;

/**
 * Environment for the adapter child.
 *
 * Three things have to be true at once, and the pre-fix code got all three
 * wrong by passing `options.env` straight through:
 *
 * 1. A caller that supplies `env` must not thereby strip `PATH` and `HOME` —
 *    without them the adapter cannot find a binary or its `~/.claude`
 *    credentials. So the sanitized inherited environment is the BASE.
 * 2. `buildSafeEnv` is an allowlist, so it is applied to the INHERITED
 *    environment only. The caller's own `env` is overlaid verbatim afterwards:
 *    it was passed deliberately, and filtering it would silently drop exactly
 *    the provider keys a caller passes `env` to deliver.
 * 3. `ELECTRON_RUN_AS_NODE=1` whenever the exec path is `process.execPath`
 *    (measured on Electron 40.2.1: without it the child comes up as a browser
 *    process and never exits). Same merge as `terminal-host/session.ts`.
 */
export function spawnAcpChildEnv(
	execPath: string,
	callerEnv: Record<string, string> | undefined,
	inherited: Record<string, string> = process.env as Record<string, string>,
): Record<string, string> {
	const merged: Record<string, string> = {
		...buildSafeEnv(inherited),
		...callerEnv,
	};
	if (execPath === process.execPath) {
		merged.ELECTRON_RUN_AS_NODE = "1";
	}
	// 4. Last, so neither the inherited environment NOR a caller that widens
	//    `env` later can hand the adapter a hooks identity (see above).
	for (const name of ACP_STRIPPED_HOOK_ENV_VARS) {
		delete merged[name];
	}
	return merged;
}
