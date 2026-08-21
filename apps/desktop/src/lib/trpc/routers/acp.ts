/**
 * ACP pane router (Phase 2, D4 + §3).
 *
 * The whole main-process surface an ACP pane needs: create a session lazily on
 * first mount, prompt, cancel, dispose, read back state, and one subscription
 * per pane carrying every protocol update.
 *
 * The host is imported through `main/lib/acp-host` — the shim — and never from
 * `@ade/server-core/acp-host` directly. That import is what makes "a pane was
 * created before the binary resolver was registered" impossible: the router is
 * the only code path that can create a session, it cannot load without the
 * shim, and the shim registers at module top level.
 */

import { EventEmitter } from "node:events";
import { observable } from "@trpc/server/observable";
import {
	type AcpExitInfo,
	type AcpHost,
	type AcpSessionInfo,
	type AcpSessionUpdate,
	acpChildEnv,
	getAcpHost,
} from "main/lib/acp-host";
import { z } from "zod";
import { publicProcedure, router } from "..";

/**
 * What the renderer sees. `update` carries the full Phase 1 union untouched,
 * so Phases 3-5 are renderer-only work against an already-complete stream.
 *
 * `turn_end` / `turn_error` are SYNTHETIC — emitted by the `prompt` mutation
 * when `host.prompt()` settles. Ordering is sound because every update frame
 * for a turn arrives on the child's stdout before the `session/prompt`
 * response, and the SDK dispatches in order. Putting the turn boundary in the
 * same stream as the updates is what stops the renderer racing the mutation's
 * own resolution across a second IPC channel.
 */
export type AcpPaneEvent =
	| { type: "update"; update: AcpSessionUpdate }
	| { type: "turn_end"; stopReason: string }
	| { type: "turn_error"; message: string }
	| {
			type: "session_exit";
			code: number | null;
			signal: string | null;
			expected: boolean;
	  }
	| { type: "session_error"; message: string };

const SAFE_ID = z
	.string()
	.min(1)
	.refine(
		(value) =>
			!value.includes("/") && !value.includes("\\") && !value.includes(".."),
		{ message: "Invalid id" },
	);

export interface AcpRouterDeps {
	host?: AcpHost;
	/**
	 * Extra child env, evaluated per session so a Claude Code installed while
	 * the app is running is picked up without a restart. THROWS
	 * `acp-claude-not-found` when there is no CLI to drive — deliberately
	 * before the spawn, so the pane shows the fix instead of a 15 s timeout.
	 */
	childEnv?: () => Record<string, string>;
}

export const createAcpRouter = (deps: AcpRouterDeps = {}) => {
	const host = deps.host ?? getAcpHost();
	const childEnv = deps.childEnv ?? acpChildEnv;

	/**
	 * Router-local fan-out. One event name per pane carrying the whole
	 * `AcpPaneEvent` union, so a subscription attaches ONE listener and its
	 * teardown detaches exactly that one.
	 *
	 * The indirection is not decoration. `AcpHost` removes ALL of a pane's
	 * listeners when its session exits or is disposed (`removePaneListeners`),
	 * which is correct for it — a dead generation's listeners must not receive
	 * the next generation's events. But it means a subscription attached
	 * directly to the host goes deaf the moment the session dies, and the
	 * design's own "New session" button (D6) would then produce a live child
	 * whose output never reaches the pane. The bridge is re-installed by
	 * `ensureSession`, which is the only thing that can start a generation.
	 */
	const paneEvents = new EventEmitter();
	// Node's default of 10 is a warning threshold for LEAKS; a pane legitimately
	// has one listener, but several panes' subscriptions share this emitter only
	// through distinct event names, so the default is already per-name. Left at
	// the default deliberately: a count above 1 for one pane IS a leak.

	interface HostBridge {
		onUpdate: (update: AcpSessionUpdate) => void;
		onExit: (info: AcpExitInfo) => void;
		onError: (err: Error) => void;
	}
	const bridges = new Map<string, HostBridge>();

	function emitPaneEvent(paneId: string, event: AcpPaneEvent): void {
		paneEvents.emit(`event:${paneId}`, event);
	}

	function detachBridge(paneId: string): void {
		const bridge = bridges.get(paneId);
		if (!bridge) return;
		host.off(`update:${paneId}`, bridge.onUpdate);
		host.off(`exit:${paneId}`, bridge.onExit);
		host.off(`error:${paneId}`, bridge.onError);
		bridges.delete(paneId);
	}

	function attachBridge(paneId: string): void {
		// Idempotent: a second `ensureSession` for a live pane must not double
		// every update. Detaching first also covers the case where the host
		// already wiped our handlers on a previous session's exit.
		detachBridge(paneId);
		const bridge: HostBridge = {
			onUpdate: (update) => emitPaneEvent(paneId, { type: "update", update }),
			onExit: (info) =>
				emitPaneEvent(paneId, {
					type: "session_exit",
					code: info.code,
					signal: info.signal,
					expected: info.expected,
				}),
			onError: (err) =>
				emitPaneEvent(paneId, {
					type: "session_error",
					message: err.message,
				}),
		};
		host.on(`update:${paneId}`, bridge.onUpdate);
		host.on(`exit:${paneId}`, bridge.onExit);
		host.on(`error:${paneId}`, bridge.onError);
		bridges.set(paneId, bridge);
	}

	return router({
		/**
		 * Lazy create, on first mount of the pane. Idempotent end to end: Phase
		 * 1's `pendingSessions` dedupe absorbs a double mount (StrictMode, mosaic
		 * re-mounts) and a live pane short-circuits to its current info.
		 */
		ensureSession: publicProcedure
			.input(z.object({ paneId: SAFE_ID, cwd: z.string().min(1) }))
			.mutation(async ({ input }): Promise<AcpSessionInfo> => {
				const existing = host.getSessionInfo(input.paneId);
				if (existing) return existing;

				// Before the spawn: updates emitted during startup are not dropped.
				attachBridge(input.paneId);
				return await host.createSession({
					paneId: input.paneId,
					cwd: input.cwd,
					env: childEnv(),
				});
			}),

		prompt: publicProcedure
			.input(z.object({ paneId: SAFE_ID, text: z.string() }))
			.mutation(async ({ input }) => {
				try {
					const result = await host.prompt(input.paneId, input.text);
					emitPaneEvent(input.paneId, {
						type: "turn_end",
						stopReason: result.stopReason,
					});
					return result;
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					emitPaneEvent(input.paneId, { type: "turn_error", message });
					throw error;
				}
			}),

		/** No-op for an idle or already-gone pane; never throws. */
		cancel: publicProcedure
			.input(z.object({ paneId: SAFE_ID }))
			.mutation(async ({ input }) => {
				await host.cancel(input.paneId);
				return { ok: true as const };
			}),

		/** Idempotent, including for a pane the host has never heard of. */
		dispose: publicProcedure
			.input(z.object({ paneId: SAFE_ID }))
			.mutation(async ({ input }) => {
				await host.disposeSession(input.paneId);
				detachBridge(input.paneId);
				return { ok: true as const };
			}),

		/** Remount reconciliation: "is my session still alive?" */
		state: publicProcedure
			.input(z.object({ paneId: SAFE_ID }))
			.query(({ input }): AcpSessionInfo | null => {
				return host.getSessionInfo(input.paneId) ?? null;
			}),

		events: publicProcedure
			.input(z.object({ paneId: SAFE_ID }))
			.subscription(({ input }) => {
				return observable<AcpPaneEvent>((emit) => {
					const onEvent = (event: AcpPaneEvent) => emit.next(event);
					paneEvents.on(`event:${input.paneId}`, onEvent);
					return () => {
						paneEvents.off(`event:${input.paneId}`, onEvent);
					};
				});
			}),
	});
};

export type AcpRouter = ReturnType<typeof createAcpRouter>;
