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
