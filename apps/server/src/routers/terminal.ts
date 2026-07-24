import { createRequire } from "node:module";
import { join } from "node:path";
import { localDb } from "@ade/server-core/local-db";
import { getProviderKey } from "@ade/server-core/provider-keys";
import {
	getDaemonTerminalManager,
	restartDaemon,
} from "@ade/server-core/terminal";
import { setOpenRouterKeyResolver } from "@ade/server-core/terminal/env";
import {
	setDaemonExecPathResolver,
	setDaemonScriptPathResolver,
} from "@ade/server-core/terminal-host/client";
import { workspaces, worktrees } from "@superset/local-db";
import { observable } from "@trpc/server/observable";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { authedProcedure, router } from "../trpc";
import { getWriterLeaseRegistry } from "../writer-lease";

// The daemon runs under plain Node from a CJS bundle (see scripts/build.ts),
// where it sits next to server.cjs in dist/. import.meta.url is undefined in
// that bundle, so resolve via __dirname there and fall back to createRequire
// only in source/tooling mode.
const daemonBundle =
	typeof __dirname !== "undefined"
		? join(__dirname, "terminal-host.cjs")
		: createRequire(import.meta.url).resolve(
				"@ade/server-core/terminal-host/daemon",
			);
setDaemonScriptPathResolver(() => daemonBundle);
setDaemonExecPathResolver(() =>
	process.versions.bun ? "node" : process.execPath,
);

// Inject the stored OpenRouter key into agent terminals (kimi/minimax/glm run
// Claude Code pointed at OpenRouter). Decrypted server-side only.
setOpenRouterKeyResolver(() => getProviderKey("openrouter"));

function terminal() {
	return getDaemonTerminalManager();
}

// Multi-device attach policy (issue #7, mirror-readonly v1): per pane, the
// first attaching client holds the writer lease; concurrent attaches from
// other clients get a live read-only mirror. See ../writer-lease.ts for the
// full lifecycle semantics.
function leases() {
	return getWriterLeaseRegistry();
}

/** Resolve a workspace's on-disk worktree path for cwd defaulting. */
function workspaceCwd(workspaceId: string): string | undefined {
	const ws = localDb
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.get();
	if (!ws?.worktreeId) return undefined;
	const wt = localDb
		.select()
		.from(worktrees)
		.where(eq(worktrees.id, ws.worktreeId))
		.get();
	return wt?.path;
}

/**
 * Terminal router — mirrors the desktop router paths (PHASE_2: the desktop
 * router tree is the API contract) over the extracted DaemonTerminalManager,
 * so the renderer's terminal UI works unchanged. The manager owns scrollback,
 * history, and the per-pane event fan-out.
 */
export const terminalRouter = router({
	createOrAttach: authedProcedure
		.input(
			z.object({
				paneId: z.string(),
				tabId: z.string(),
				workspaceId: z.string(),
				cols: z.number().optional(),
				rows: z.number().optional(),
				cwd: z.string().optional(),
				skipColdRestore: z.boolean().optional(),
				allowKilled: z.boolean().optional(),
				themeType: z.enum(["dark", "light"]).optional(),
				clientId: z.string().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			const ws = localDb
				.select()
				.from(workspaces)
				.where(eq(workspaces.id, input.workspaceId))
				.get();
			const workspacePath = workspaceCwd(input.workspaceId);
			const result = await terminal().createOrAttach({
				paneId: input.paneId,
				tabId: input.tabId,
				workspaceId: input.workspaceId,
				workspaceName: ws?.name,
				workspacePath,
				cwd: input.cwd ?? workspacePath,
				cols: input.cols,
				rows: input.rows,
				skipColdRestore: input.skipColdRestore,
				allowKilled: input.allowKilled,
				themeType: input.themeType,
				runtime: ws?.runtime ?? null,
			});
			// Lease decision only after a successful attach; anonymous callers
			// (no clientId) don't participate in the policy.
			const readOnly = input.clientId
				? leases().attach(input.paneId, input.clientId).readOnly
				: false;
			return {
				paneId: input.paneId,
				isNew: result.isNew,
				scrollback: result.scrollback,
				wasRecovered: result.wasRecovered,
				isColdRestore: result.isColdRestore,
				previousCwd: result.previousCwd,
				claudeSessionId: result.claudeSessionId,
				snapshot: result.snapshot,
				readOnly,
			};
		}),

	write: authedProcedure
		.input(
			z.object({
				paneId: z.string(),
				data: z.string(),
				clientId: z.string().optional(),
			}),
		)
		.mutation(({ input }) => {
			// Mirrored clients' input is dropped server-side; their UI also
			// suppresses it locally, so this is the defense-in-depth layer.
			if (!leases().allowWrite(input.paneId, input.clientId)) return;
			terminal().write({ paneId: input.paneId, data: input.data });
		}),

	resize: authedProcedure
		.input(
			z.object({
				paneId: z.string(),
				cols: z.number().int().min(1).max(1000),
				rows: z.number().int().min(1).max(1000),
				clientId: z.string().optional(),
			}),
		)
		.mutation(({ input }) => {
			// The writer's viewport owns the PTY dimensions; mirror resizes
			// (window drags on a read-only device) are ignored.
			if (!leases().allowResize(input.paneId, input.clientId)) return;
			terminal().resize({
				paneId: input.paneId,
				cols: input.cols,
				rows: input.rows,
			});
		}),

	signal: authedProcedure
		.input(
			z.object({
				paneId: z.string(),
				signal: z.string().optional(),
				clientId: z.string().optional(),
			}),
		)
		.mutation(({ input }) => {
			if (!leases().allowWrite(input.paneId, input.clientId)) return;
			terminal().signal({ paneId: input.paneId, signal: input.signal });
		}),

	/**
	 * Explicit takeover from a mirrored client (last-writer-wins on user
	 * action). The demoted writer learns via a `mode` event on its stream.
	 */
	takeWriter: authedProcedure
		.input(z.object({ paneId: z.string(), clientId: z.string() }))
		.mutation(({ input }) => {
			leases().takeOver(input.paneId, input.clientId);
			return { readOnly: false };
		}),

	kill: authedProcedure
		.input(z.object({ paneId: z.string() }))
		.mutation(async ({ input }) => {
			await terminal().kill({ paneId: input.paneId });
			leases().clear(input.paneId);
		}),

	detach: authedProcedure
		.input(z.object({ paneId: z.string(), clientId: z.string().optional() }))
		.mutation(({ input }) => {
			terminal().detach({ paneId: input.paneId });
			if (input.clientId) leases().release(input.paneId, input.clientId);
		}),

	clearScrollback: authedProcedure
		.input(z.object({ paneId: z.string() }))
		.mutation(async ({ input }) => {
			await terminal().clearScrollback(input);
		}),

	listDaemonSessions: authedProcedure.query(async () => {
		return terminal().listDaemonSessions();
	}),

	/**
	 * Latency fallback (issue #59): a cheap client→server→daemon round trip,
	 * measured client-side by useTerminalLatency only when the user hasn't
	 * typed for >30s (no fresh echo samples). Deliberately a mutation:
	 * terminal.* mutations ride the WS link in the webui, so this measures
	 * the same transport keystrokes use. list-sessions is the lightest
	 * existing daemon request — no new protocol message needed.
	 */
	ping: authedProcedure.mutation(async () => {
		const started = Date.now();
		await terminal().listDaemonSessions();
		return { daemonMs: Date.now() - started };
	}),

	/**
	 * Kill every live daemon session (the Terminal settings "Kill all sessions"
	 * button). Mirrors the desktop procedure: kill each pane, then poll until the
	 * daemon reports them gone so the UI's count is accurate.
	 */
	killAllDaemonSessions: authedProcedure.mutation(async () => {
		const mgr = terminal();
		const before = await mgr.listDaemonSessions();
		const beforeIds = before.sessions
			.filter((s) => s.isAlive)
			.map((s) => s.sessionId);

		if (beforeIds.length > 0) {
			await Promise.allSettled(beforeIds.map((paneId) => mgr.kill({ paneId })));
		}

		const MAX_RETRIES = 10;
		const RETRY_DELAY_MS = 100;
		let remainingCount = beforeIds.length;
		for (let i = 0; i < MAX_RETRIES && remainingCount > 0; i++) {
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
			const after = await mgr.listDaemonSessions();
			remainingCount = after.sessions.filter((s) => s.isAlive).length;
		}

		return {
			killedCount: beforeIds.length - remainingCount,
			remainingCount,
		};
	}),

	/** Drop persisted scrollback used for reboot/crash recovery. */
	clearTerminalHistory: authedProcedure.mutation(async () => {
		await terminal().resetHistoryPersistence();
		return { success: true };
	}),

	/** Restart the terminal daemon to recover from a stuck state (kills all). */
	restartDaemon: authedProcedure.mutation(async () => {
		return restartDaemon();
	}),

	/**
	 * Per-pane stream. Exit is a state transition, NOT stream completion
	 * (paneId is reused across restarts) — matches the desktop invariant.
	 *
	 * The object input form carries the attach-policy clientId: it binds the
	 * subscription as the client's liveness signal for the writer lease and
	 * enables `mode` events (initial + on every lease change). The plain
	 * string form stays supported for scripts and older clients.
	 */
	stream: authedProcedure
		.input(
			z.union([
				z.string(),
				z.object({ paneId: z.string(), clientId: z.string().optional() }),
			]),
		)
		.subscription(({ input }) => {
			const paneId = typeof input === "string" ? input : input.paneId;
			const clientId = typeof input === "string" ? undefined : input.clientId;
			return observable<
				| { type: "data"; data: string }
				| {
						type: "exit";
						exitCode: number;
						signal?: number;
						reason?: "killed" | "exited" | "error";
				  }
				| { type: "disconnect"; reason: string }
				| { type: "error"; error: string; code?: string }
				| { type: "mode"; readOnly: boolean }
			>((emit) => {
				const mgr = terminal();
				const onData = (data: string) => emit.next({ type: "data", data });
				const onExit = (
					exitCode: number,
					signal?: number,
					reason?: "killed" | "exited" | "error",
				) => emit.next({ type: "exit", exitCode, signal, reason });
				const onDisconnect = (reason: string) =>
					emit.next({ type: "disconnect", reason });
				const onError = (payload: { error: string; code?: string }) =>
					emit.next({
						type: "error",
						error: payload.error,
						code: payload.code,
					});

				mgr.on(`data:${paneId}`, onData);
				mgr.on(`exit:${paneId}`, onExit);
				mgr.on(`disconnect:${paneId}`, onDisconnect);
				mgr.on(`error:${paneId}`, onError);

				let unbindLease: (() => void) | undefined;
				if (clientId) {
					const emitMode = () =>
						emit.next({
							type: "mode",
							readOnly: leases().isReadOnly(paneId, clientId),
						});
					unbindLease = leases().bindSubscription(paneId, clientId, emitMode);
					// Tell the client where it stands right away — the renderer
					// gates its input purely on these events.
					emitMode();
				}

				return () => {
					mgr.off(`data:${paneId}`, onData);
					mgr.off(`exit:${paneId}`, onExit);
					mgr.off(`disconnect:${paneId}`, onDisconnect);
					mgr.off(`error:${paneId}`, onError);
					unbindLease?.();
				};
			});
		}),
});
