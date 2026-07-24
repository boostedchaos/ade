import { getTerminalHostClient } from "../terminal-host/client";
import type { ListSessionsResponse } from "../terminal-host/types";
import { DaemonTerminalManager, getDaemonTerminalManager } from "./daemon";
import { prewarmTerminalEnv, setOpenRouterKeyResolver } from "./env";
import {
	RECONCILE_STARTUP_TIMEOUT_MS,
	reconcileWithTimeout,
} from "./reconcile";

// Host apps wire their key store via setOpenRouterKeyResolver (./env) and
// their analytics/UI-state/DB via setTerminalManagerHooks (./host-hooks) —
// the desktop does this in its main/lib/terminal shim, ade-server in
// its terminal router.

export { DaemonTerminalManager, getDaemonTerminalManager };
export type { DaemonConnectionStatus } from "./daemon/daemon-manager";
export type {
	CreateSessionParams,
	SessionResult,
	TerminalDataEvent,
	TerminalEvent,
	TerminalExitEvent,
} from "./types";

const DEBUG_TERMINAL = process.env.SUPERSET_TERMINAL_DEBUG === "1";
let prewarmInFlight: Promise<void> | null = null;

/**
 * Reconcile daemon sessions on app startup.
 * Cleans up stale sessions from previous app runs and preserves sessions
 * that can be retained. Bounded by a hard timeout so a wedged daemon can never
 * brick boot — reconcileOnStartup runs before the main window is created (see
 * reconcileWithTimeout). `timeoutMs` is injectable for tests.
 */
export async function reconcileDaemonSessions(
	timeoutMs: number = RECONCILE_STARTUP_TIMEOUT_MS,
): Promise<void> {
	await reconcileWithTimeout(getDaemonTerminalManager(), timeoutMs);
}

/**
 * Restart the terminal daemon. Kills all sessions, shuts down the daemon,
 * and resets the manager so a fresh daemon spawns on next use.
 */
export async function restartDaemon(): Promise<{ success: boolean }> {
	console.log("[restartDaemon] Starting daemon restart...");

	try {
		const client = getTerminalHostClient();
		const connected = await client.tryConnectAndAuthenticate();

		if (connected) {
			const { sessions } = await client.listSessions();
			const aliveCount = sessions.filter((s) => s.isAlive).length;
			console.log(
				`[restartDaemon] Shutting down daemon with ${aliveCount} alive sessions`,
			);

			await client.shutdownIfRunning({ killSessions: true });
		} else {
			console.log("[restartDaemon] Daemon was not running");
		}
	} catch (error) {
		console.warn("[restartDaemon] Error during shutdown (continuing):", error);
	}

	const manager = getDaemonTerminalManager();
	manager.reset();

	console.log("[restartDaemon] Complete");

	return { success: true };
}

/**
 * Graceful-shutdown: flush terminal history (write `endedAt`) while leaving the
 * daemon + its sessions running in the background. Stops the reconnect loop
 * first so a pending backoff can't fire during quit.
 */
export async function flushTerminalHistoryOnQuit(): Promise<void> {
	const manager = getDaemonTerminalManager();
	manager.prepareForShutdown();
	await manager.flushHistoryForQuit();
}

/**
 * Graceful-shutdown: stop all agent sessions and shut the daemon down (the
 * "stop agents on quit" policy). forceKillAll writes `endedAt` via its history
 * flush, then the daemon itself is asked to exit.
 */
export async function stopAllAgentsOnQuit(): Promise<void> {
	const manager = getDaemonTerminalManager();
	manager.prepareForShutdown();
	await manager.forceKillAll();
	await getTerminalHostClient().shutdownIfRunning({ killSessions: true });
}

/** Graceful-shutdown: drop the daemon socket without stopping the daemon. */
export function disconnectTerminalHostOnQuit(): void {
	getTerminalHostClient().disconnect();
}

export async function tryListExistingDaemonSessions(): Promise<{
	sessions: ListSessionsResponse["sessions"];
}> {
	try {
		const client = getTerminalHostClient();
		const result = await client.listSessions();
		return { sessions: result.sessions };
	} catch (error) {
		console.warn(
			"[TerminalManager] Failed to list existing daemon sessions (getTerminalHostClient/client.listSessions):",
			error,
		);
		if (DEBUG_TERMINAL) {
			console.log(
				"[TerminalManager] Failed to list existing daemon sessions:",
				error,
			);
		}
		return { sessions: [] };
	}
}

/**
 * Best-effort terminal runtime warmup.
 * Runs in the background to reduce latency for the first user-opened terminal:
 * - precomputes locale/env fallback
 * - ensures daemon control/stream channels are established
 */
export function prewarmTerminalRuntime(): void {
	if (prewarmInFlight) return;

	prewarmInFlight = (async () => {
		try {
			prewarmTerminalEnv();
		} catch (error) {
			if (DEBUG_TERMINAL) {
				console.warn(
					"[TerminalManager] Failed to prewarm terminal env:",
					error,
				);
			}
		}

		try {
			await getTerminalHostClient().ensureConnected();
		} catch (error) {
			if (DEBUG_TERMINAL) {
				console.warn(
					"[TerminalManager] Failed to prewarm terminal daemon connection:",
					error,
				);
			}
		}
	})().finally(() => {
		prewarmInFlight = null;
	});
}
