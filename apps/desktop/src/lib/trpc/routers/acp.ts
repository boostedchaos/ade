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
	type AcpConfigOption,
	type AcpExitInfo,
	type AcpHost,
	type AcpPendingElicitation,
	type AcpPendingPermission,
	type AcpSessionInfo,
	type AcpSessionUpdate,
	acpChildEnv,
	getAcpHost,
	type PermissionPolicy,
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
	| { type: "session_error"; message: string }
	/**
	 * The agent is blocked on the user (A4/A5). Answer with
	 * `answerPermission` / `answerElicitation`, naming the `requestId`.
	 *
	 * A permission request only ever appears under the `"prompt"` policy; the
	 * default `"auto-approve"` emits nothing at all.
	 */
	| ({ type: "permission_request" } & AcpPendingPermission)
	| ({ type: "elicitation_request" } & AcpPendingElicitation)
	/**
	 * The pane's start-up backlog overran the buffer and this many events were
	 * dropped, oldest first (A2).
	 *
	 * Synthetic, and delivered FIRST so it is impossible to read the replay
	 * that follows as complete. Silence here is the failure mode worth paying a
	 * union member to avoid: a truncated conversation and a whole one look
	 * identical.
	 */
	| { type: "events_dropped"; count: number };

/**
 * What a config write actually did, as opposed to what it was asked to do.
 *
 * `actualValue` is read off the wire AFTER the write. The outcome is
 * three-valued, not two (A2): the write landed, the adapter applied something
 * else, or the read-back reported nothing at all and neither claim can be made.
 * The renderer shows `actualValue`, never `requestedValue`.
 */
export interface AcpConfigApplied {
	configId: string;
	requestedValue: string;
	actualValue: string | null;
	/** The read-back proved the requested value landed. */
	verified: boolean;
	/**
	 * The read-back carried nothing off the wire, so this write is neither
	 * confirmed nor refuted. Distinct from `verified: false`, which is a
	 * positive claim that something ELSE is set (A2).
	 */
	unverified: boolean;
	/**
	 * Not verified, but the adapter merely canonicalized an alias the user
	 * plainly meant ("opus" → "claude-opus-5"). Warning about this is crying
	 * wolf, and a chip that fires on correct writes trains the user to ignore
	 * the one that matters (A4).
	 */
	canonicalized: boolean;
}

export interface AcpSetConfigOptionResult {
	configOptions: AcpConfigOption[];
	/**
	 * Generation of the host's config cache this list came from. The renderer
	 * refuses a list older than the one it holds — this return value and the
	 * `config_option_update` subscription are separate IPC channels and nothing
	 * orders them against each other (A1).
	 */
	seq: number;
	applied: AcpConfigApplied;
}

/** A read-back, with the same ordering stamp and honesty marker as a write. */
export interface AcpReadConfigResult {
	configOptions: AcpConfigOption[];
	seq: number;
	/** The resume answered without any options; this list is cache, not wire. */
	unverified: boolean;
}

/**
 * Did the adapter canonicalize what was asked for, or substitute something else?
 *
 * Substring, case-insensitive, against the applied option's id AND its label —
 * "opus" is contained in `claude-opus-5`, "claude-haiku-99" is contained in
 * neither. A null `actualValue` (the option vanished) has nothing to match and
 * is always a substitution.
 */
function isCanonicalization(
	requestedValue: string,
	actualValue: string | null,
	applied: AcpConfigOption | undefined,
): boolean {
	if (actualValue === null) return false;
	const needle = requestedValue.trim().toLowerCase();
	if (needle === "") return false;
	const label = applied?.values?.find(
		(value) => value.id === actualValue,
	)?.label;
	return [actualValue, label].some((candidate) =>
		candidate?.toLowerCase().includes(needle),
	);
}

const SAFE_ID = z
	.string()
	.min(1)
	.refine(
		(value) =>
			!value.includes("/") && !value.includes("\\") && !value.includes(".."),
		{ message: "Invalid id" },
	);

/**
 * How many events a pane may bank before its subscription attaches (A2).
 *
 * Sized for a `session/load` replay of a long conversation, which is the only
 * thing that can produce a large backlog: the pane starts its session before
 * the subscription mounts, and a load replays the ENTIRE history as ordinary
 * updates in that window. 5000 covers a very long conversation; past it the
 * oldest go, because the newest frames are the ones that describe the state
 * the pane is about to be in.
 */
const EVENT_BUFFER_CAP = 5000;

/** Events banked for a pane whose subscription has not attached yet. */
interface PaneEventBuffer {
	events: AcpPaneEvent[];
	dropped: number;
}

export interface AcpRouterDeps {
	host?: AcpHost;
	/**
	 * Extra child env, evaluated per session so a Claude Code installed while
	 * the app is running is picked up without a restart. THROWS
	 * `acp-claude-not-found` when there is no CLI to drive — deliberately
	 * before the spawn, so the pane shows the fix instead of a 15 s timeout.
	 */
	childEnv?: () => Record<string, string>;
	/**
	 * The permission policy a NEW session starts under, read per session so a
	 * settings change applies without a restart (A4).
	 *
	 * Defaults to `"auto-approve"` — matching the settings column's own default
	 * and Phase 2's behavior — rather than reading the database here: this
	 * module is unit-tested without Electron, and importing the local-db module
	 * opens the DB and runs migrations at import time. The desktop app injects
	 * the real reader in `routers/index.ts`.
	 */
	permissionPolicy?: () => PermissionPolicy;
}

export const createAcpRouter = (deps: AcpRouterDeps = {}) => {
	const host = deps.host ?? getAcpHost();
	const childEnv = deps.childEnv ?? acpChildEnv;
	const permissionPolicy = deps.permissionPolicy ?? (() => "auto-approve");

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
		onPermission: (req: AcpPendingPermission) => void;
		onElicitation: (req: AcpPendingElicitation) => void;
	}
	const bridges = new Map<string, HostBridge>();

	/**
	 * Per-pane event backlog, alive only until the pane's first subscription
	 * attaches (A2).
	 *
	 * `AcpPane` starts its session before the subscription mounts. Live traffic
	 * survives that window because the agent has nothing to say yet, but a
	 * `session/load` replays the whole conversation into it — every frame of it
	 * before anything is listening. Banking events from session start closes
	 * that race for the load and for every future early emitter.
	 */
	const buffers = new Map<string, PaneEventBuffer>();
	/**
	 * How many `events` subscriptions each pane currently has attached.
	 *
	 * Buffering is only ever a stand-in for a listener that is not there yet.
	 * A pane that subscribes BEFORE starting its session — which the router
	 * fully supports — must not have its stream diverted into a buffer nobody
	 * will drain, and neither must a live subscriber when a second session
	 * starts under it after the first one died.
	 */
	const subscriberCounts = new Map<string, number>();

	function subscriberCount(paneId: string): number {
		return subscriberCounts.get(paneId) ?? 0;
	}

	function emitPaneEvent(paneId: string, event: AcpPaneEvent): void {
		const buffer = buffers.get(paneId);
		if (buffer) {
			if (buffer.events.length >= EVENT_BUFFER_CAP) {
				buffer.events.shift();
				buffer.dropped++;
			}
			buffer.events.push(event);
			return;
		}
		paneEvents.emit(`event:${paneId}`, event);
	}

	function detachBridge(paneId: string): void {
		const bridge = bridges.get(paneId);
		if (!bridge) return;
		host.off(`update:${paneId}`, bridge.onUpdate);
		host.off(`exit:${paneId}`, bridge.onExit);
		host.off(`error:${paneId}`, bridge.onError);
		host.off(`permission:${paneId}`, bridge.onPermission);
		host.off(`elicitation:${paneId}`, bridge.onElicitation);
		bridges.delete(paneId);
	}

	function attachBridge(paneId: string): void {
		// Idempotent: a second `ensureSession` for a live pane must not double
		// every update. Detaching first also covers the case where the host
		// already wiped our handlers on a previous session's exit.
		detachBridge(paneId);
		// A pane with no listener yet gets a backlog; one that already has a
		// subscription needs no stand-in for it.
		//
		// An EXISTING backlog is kept, never replaced (A7). `getSessionInfo`
		// answers nothing while the first `createSession` is still in flight, so
		// a double mount lands two `attachBridge` calls around a `session/load`
		// whose entire history is already banked — and recreating the buffer
		// there would discard that replay and reset `dropped` to zero, which is
		// worse than the loss because a truncated backlog then reads as a whole
		// one. Nothing stale can survive here: a previous generation's buffer is
		// dropped when its session exits or is disposed.
		if (subscriberCount(paneId) === 0) {
			if (!buffers.has(paneId)) {
				buffers.set(paneId, { events: [], dropped: 0 });
			}
		} else {
			buffers.delete(paneId);
		}
		const bridge: HostBridge = {
			onUpdate: (update) => emitPaneEvent(paneId, { type: "update", update }),
			onPermission: (req) =>
				emitPaneEvent(paneId, { type: "permission_request", ...req }),
			onElicitation: (req) =>
				emitPaneEvent(paneId, { type: "elicitation_request", ...req }),
			onExit: (info) => {
				emitPaneEvent(paneId, {
					type: "session_exit",
					code: info.code,
					signal: info.signal,
					expected: info.expected,
				});
				// Symmetry with `dispose` (A11/F8): what this child banked
				// describes a conversation that is over, and replaying it into
				// the next generation's pane would read as the new session
				// having already spoken. Deleted AFTER the emit above so a live
				// subscriber still receives the exit itself.
				buffers.delete(paneId);
			},
			onError: (err) =>
				emitPaneEvent(paneId, {
					type: "session_error",
					message: err.message,
				}),
		};
		host.on(`update:${paneId}`, bridge.onUpdate);
		host.on(`exit:${paneId}`, bridge.onExit);
		host.on(`error:${paneId}`, bridge.onError);
		host.on(`permission:${paneId}`, bridge.onPermission);
		host.on(`elicitation:${paneId}`, bridge.onElicitation);
		bridges.set(paneId, bridge);
	}

	return router({
		/**
		 * Lazy create, on first mount of the pane. Idempotent end to end: Phase
		 * 1's `pendingSessions` dedupe absorbs a double mount (StrictMode, mosaic
		 * re-mounts) and a live pane short-circuits to its current info.
		 */
		ensureSession: publicProcedure
			.input(
				z.object({
					paneId: SAFE_ID,
					cwd: z.string().min(1),
					/**
					 * A previous ACP session id to restore (A1). The whole stored
					 * conversation replays into the event stream; an id the agent no
					 * longer knows falls back to a new session, which the returned
					 * `restored` field reports.
					 */
					resumeSessionId: z.string().min(1).optional(),
				}),
			)
			.mutation(async ({ input }): Promise<AcpSessionInfo> => {
				const existing = host.getSessionInfo(input.paneId);
				if (existing) return existing;

				// Before the spawn: updates emitted during startup are not dropped.
				// This is also what installs the pane's event buffer, which a
				// restore's instant replay depends on.
				attachBridge(input.paneId);
				return await host.createSession({
					paneId: input.paneId,
					cwd: input.cwd,
					env: childEnv(),
					permissionPolicy: permissionPolicy(),
					...(input.resumeSessionId
						? { resumeSessionId: input.resumeSessionId }
						: {}),
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
				// The backlog dies with the pane; nothing will ever drain it now.
				buffers.delete(input.paneId);
				return { ok: true as const };
			}),

		/**
		 * Answer a `permission_request` (A4).
		 *
		 * Throws `acp-request-not-found` for an id that is no longer pending,
		 * which is the ordinary shape of a double-click and of an answer that
		 * lost a race with the turn being cancelled — the caller should treat it
		 * as "already settled", not as a failure to report.
		 */
		answerPermission: publicProcedure
			.input(
				z.object({
					paneId: SAFE_ID,
					requestId: z.string().min(1),
					optionId: z.string().min(1),
				}),
			)
			.mutation(({ input }) => {
				host.answerPermission(input.paneId, input.requestId, input.optionId);
				return { ok: true as const };
			}),

		/** Answer an `elicitation_request` (A5). Same lifecycle as above. */
		answerElicitation: publicProcedure
			.input(
				z.object({
					paneId: SAFE_ID,
					requestId: z.string().min(1),
					answer: z.discriminatedUnion("action", [
						z.object({
							action: z.literal("accept"),
							// String and string-array only: those are the only field
							// kinds the host will render a form for at all, so a numeric
							// or boolean value here could not have come from one.
							content: z.record(
								z.string(),
								z.union([z.string(), z.array(z.string())]),
							),
						}),
						z.object({ action: z.literal("decline") }),
						z.object({ action: z.literal("cancel") }),
					]),
				}),
			)
			.mutation(({ input }) => {
				host.answerElicitation(input.paneId, input.requestId, input.answer);
				return { ok: true as const };
			}),

		/**
		 * Write one config option, then prove what landed.
		 *
		 * The read-back is not an optional confirmation step: `session/
		 * set_config_option` answers success for a value it silently replaced,
		 * so the write's own result carries no information. `allowUnlisted` is
		 * the typed-model escape hatch and the host restricts it to the model
		 * option (`AcpSession.setConfigOption`).
		 */
		setConfigOption: publicProcedure
			.input(
				z.object({
					paneId: SAFE_ID,
					configId: z.string().min(1),
					value: z.string(),
					allowUnlisted: z.boolean().optional(),
				}),
			)
			.mutation(async ({ input }): Promise<AcpSetConfigOptionResult> => {
				await host.setConfigOption(input.paneId, input.configId, input.value, {
					allowUnlisted: input.allowUnlisted,
				});

				const snapshot = await host.readConfig(input.paneId);
				const appliedOption = snapshot.options.find(
					(option) => option.id === input.configId,
				);
				const actualValue = appliedOption?.currentValue ?? null;
				// Nothing came off the wire, so the list is the host's own cache
				// and it cannot support EITHER claim about this write (A2).
				const unverified = !snapshot.fromWire;
				const verified = !unverified && actualValue === input.value;

				return {
					configOptions: snapshot.options,
					seq: snapshot.seq,
					applied: {
						configId: input.configId,
						requestedValue: input.value,
						actualValue,
						verified,
						unverified,
						canonicalized:
							!verified &&
							!unverified &&
							isCanonicalization(input.value, actualValue, appliedOption),
					},
				};
			}),

		/**
		 * On-demand config read-back. A mutation, not a query: it puts a
		 * `session/resume` on the wire, so it must never be cached, retried or
		 * refetched on focus the way a query is.
		 */
		readConfig: publicProcedure
			.input(z.object({ paneId: SAFE_ID }))
			.mutation(async ({ input }): Promise<AcpReadConfigResult> => {
				const snapshot = await host.readConfig(input.paneId);
				return {
					configOptions: snapshot.options,
					seq: snapshot.seq,
					unverified: !snapshot.fromWire,
				};
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

					// Drain to the FIRST subscriber, then pass through (A2). All
					// three steps run synchronously in this one tick — the emitter
					// is same-thread — so no live event can slip between deleting
					// the buffer and replaying it, and the backlog cannot arrive
					// after something that came later.
					const buffered = buffers.get(input.paneId);
					buffers.delete(input.paneId);
					subscriberCounts.set(input.paneId, subscriberCount(input.paneId) + 1);
					paneEvents.on(`event:${input.paneId}`, onEvent);
					if (buffered) {
						if (buffered.dropped > 0) {
							emit.next({ type: "events_dropped", count: buffered.dropped });
						}
						for (const event of buffered.events) emit.next(event);
					}

					return () => {
						paneEvents.off(`event:${input.paneId}`, onEvent);
						const remaining = subscriberCount(input.paneId) - 1;
						if (remaining > 0) {
							subscriberCounts.set(input.paneId, remaining);
							return;
						}
						subscriberCounts.delete(input.paneId);
						// The last listener just left a session that is still
						// running (A7). Without a buffer here every frame it
						// emits goes to nobody and is not even counted, so the
						// next attach cannot tell a quiet agent from a lost
						// conversation. A pane whose session has exited or been
						// disposed has no bridge, and banks nothing.
						if (bridges.has(input.paneId) && !buffers.has(input.paneId)) {
							buffers.set(input.paneId, { events: [], dropped: 0 });
						}
					};
				});
			}),
	});
};

export type AcpRouter = ReturnType<typeof createAcpRouter>;
