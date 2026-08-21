import type {
	AcpPaneEvent,
	AcpSetConfigOptionResult,
} from "lib/trpc/routers/acp";
import { create } from "zustand";

/**
 * The pane's config controls, and the pure reducer that maintains them.
 *
 * Everything here is a plain value transform, so the whole of the control bar's
 * logic is testable without React, IPC or an adapter — the same split
 * `transcript.ts` uses.
 *
 * The one invariant worth stating out loud: this state NEVER holds a value the
 * user asked for, only a value the adapter reported back. The adapter answers
 * success for a config write it silently resolved to something else, so an
 * optimistic control would display a lie and keep displaying it.
 */

/** The option shape the host normalizes to, without re-importing it. */
export type AcpConfigOption = AcpSetConfigOptionResult["configOptions"][number];

export interface AcpControlBarMismatch {
	configId: string;
	requestedValue: string;
	actualValue: string | null;
}

/** A write whose read-back reported nothing — neither confirmed nor refuted. */
export interface AcpControlBarUnverified {
	configId: string;
	requestedValue: string;
}

export interface AcpControlBarState {
	/** Read-back truth, in the order the adapter reported it. */
	options: AcpConfigOption[];
	/**
	 * Generation of the host cache `options` came from.
	 *
	 * Config truth reaches this reducer over two IPC channels that are not
	 * ordered against each other — the `config_option_update` subscription and
	 * a mutation's own return value — and adapter 0.63.0 emits an update
	 * mid-turn from its fast-mode sync. Without this, a read-back that was
	 * already on the wire lands afterwards and puts the bar back to a value the
	 * adapter has already abandoned (A1).
	 */
	seq: number;
	/** The option whose write is on the wire; its control is disabled. */
	pending: string | null;
	/** Set when a read-back reported a value other than the requested one. */
	mismatch: AcpControlBarMismatch | null;
	/** Set when the read-back reported nothing at all (A2). */
	unverified: AcpControlBarUnverified | null;
	/** Last write failure, verbatim. */
	error: string | null;
}

export function emptyControlBar(): AcpControlBarState {
	return {
		options: [],
		seq: 0,
		pending: null,
		mismatch: null,
		unverified: null,
		error: null,
	};
}

/**
 * Adopt an option list, unless it is older than the one already held.
 *
 * A list stamped BELOW the held generation was read before something the bar
 * has already seen, so applying it would move the display backwards (A1). An
 * equal stamp is the same generation and is accepted — re-seeding from it is a
 * no-op by construction.
 *
 * Options the adapter no longer reports take their pending, mismatch and
 * unverified state with them: each names a control that is about to stop
 * existing (D7), and a warning chip with nothing to hang off would outlive its
 * subject.
 */
function withOptions(
	state: AcpControlBarState,
	options: AcpConfigOption[],
	seq: number,
): AcpControlBarState {
	if (seq < state.seq) return state;
	const present = new Set(options.map((option) => option.id));
	return {
		...state,
		options,
		seq,
		pending: state.pending && present.has(state.pending) ? state.pending : null,
		mismatch:
			state.mismatch && present.has(state.mismatch.configId)
				? state.mismatch
				: null,
		unverified:
			state.unverified && present.has(state.unverified.configId)
				? state.unverified
				: null,
	};
}

/** Seed from `acp.state` on mount, or from an `acp.readConfig` read-back. */
export function seedOptions(
	state: AcpControlBarState,
	options: AcpConfigOption[],
	seq: number,
): AcpControlBarState {
	return withOptions(state, options, seq);
}

/**
 * Pane mount: release a write that has nothing left to settle it.
 *
 * TanStack Query v5 does not run a per-call `onSuccess`/`onError` once the
 * observer has unmounted, so a write that was in flight when the pane went away
 * never settles. `pending` disables the whole bar, and on remount there is
 * neither a spinner nor an error to explain it — the pane simply comes back
 * inert (A3). The options are kept: the mount's own read-back is what replaces
 * them, and blanking the bar first would flicker.
 */
export function paneMounted(state: AcpControlBarState): AcpControlBarState {
	if (state.pending === null) return state;
	return { ...state, pending: null };
}

/** Pure (state, event) → state. Never throws, for any event. */
export function reduceControlBarEvent(
	state: AcpControlBarState,
	event: AcpPaneEvent,
): AcpControlBarState {
	switch (event.type) {
		case "update":
			// The adapter's own unsolicited truth signal — it fires when a model
			// change adds or removes `effort`/`fast`, which is why the bar is
			// rendered from the reported list rather than a fixed layout.
			return event.update.kind === "config_option_update"
				? withOptions(state, event.update.options, event.update.seq)
				: state;
		case "session_exit":
			return emptyControlBar();
		case "session_error":
			// The child can report a fatal error WITHOUT exiting, and the write
			// that was on the wire when it did will never settle. Only
			// `session_exit` used to clear `pending`, so this path left the bar
			// disabled for good (A3). The options stay: the session is broken,
			// not reconfigured.
			return paneMounted(state);
		default:
			return state;
	}
}

export function writeStarted(
	state: AcpControlBarState,
	configId: string,
): AcpControlBarState {
	return {
		...state,
		pending: configId,
		mismatch: null,
		unverified: null,
		error: null,
	};
}

/**
 * Settle a write against its read-back.
 *
 * Three outcomes, not two (A2). The read-back either proved the value landed,
 * proved something else is set, or reported nothing at all — and the third is
 * not a success. `canonicalized` is the adapter resolving an alias the user
 * plainly meant ("opus" → "claude-opus-5"); warning about that would train the
 * user to ignore the chip that matters (A4).
 *
 * The LIST may still be refused as stale while the write itself settles: a
 * mutation that resolved must always clear `pending`, or the control it
 * disabled stays disabled.
 */
export function writeSettled(
	state: AcpControlBarState,
	result: AcpSetConfigOptionResult,
): AcpControlBarState {
	const next = withOptions(state, result.configOptions, result.seq);
	const { applied } = result;
	const substituted = !applied.verified && !applied.unverified;
	return {
		...next,
		pending: null,
		mismatch:
			substituted && !applied.canonicalized
				? {
						configId: applied.configId,
						requestedValue: applied.requestedValue,
						actualValue: applied.actualValue,
					}
				: null,
		unverified: applied.unverified
			? {
					configId: applied.configId,
					requestedValue: applied.requestedValue,
				}
			: null,
	};
}

export function writeFailed(
	state: AcpControlBarState,
	message: string,
): AcpControlBarState {
	return { ...state, pending: null, error: message };
}

// =============================================================================
// Presentation rules
// =============================================================================

/**
 * `mode` is the permission policy, not a model setting, and it is deliberately
 * absent from this bar.
 */
const EXCLUDED_ID = "mode";
const EXCLUDED_CATEGORY = "mode";

/**
 * Display order. Ids, not categories: the protocol says a category is UX
 * advice a client must not depend on, while these four ids are stable adapter
 * constants. Anything else sorts last, in reported order, so an option a future
 * adapter adds still renders.
 */
const CONTROL_ORDER = ["model", "effort", "fast", "agent"];

function rankOf(option: AcpConfigOption): number {
	const index = CONTROL_ORDER.indexOf(option.id);
	return index === -1 ? CONTROL_ORDER.length : index;
}

export function visibleControls(options: AcpConfigOption[]): AcpConfigOption[] {
	return options
		.filter(
			(option) =>
				option.id !== EXCLUDED_ID && option.category !== EXCLUDED_CATEGORY,
		)
		.map((option, index) => ({ option, index }))
		.sort((a, b) => rankOf(a.option) - rankOf(b.option) || a.index - b.index)
		.map((entry) => entry.option);
}

export type AcpControlKind = "model" | "switch" | "select";

/**
 * A two-value on/off option is a switch, not a two-item dropdown.
 *
 * `true`/`false` counts as well: that is what the host normalizes a boolean
 * option to, and the control is the same one either way.
 */
function isOnOffSelect(option: AcpConfigOption): boolean {
	const ids = option.values?.map((value) => value.id) ?? [];
	if (ids.length !== 2) return false;
	const pair = [...ids].sort().join("/");
	return pair === "off/on" || pair === "false/true";
}

export function controlKind(option: AcpConfigOption): AcpControlKind {
	if (option.id === "model") return "model";
	if (isOnOffSelect(option)) return "switch";
	return "select";
}

/** The id a switch writes for each position, whichever pair it declared. */
export function switchValues(option: AcpConfigOption): {
	on: string;
	off: string;
} {
	const ids = option.values?.map((value) => value.id) ?? [];
	return {
		on: ids.includes("on") ? "on" : "true",
		off: ids.includes("off") ? "off" : "false",
	};
}

// =============================================================================
// Per-pane store
// =============================================================================

interface AcpControlBarStore {
	byPane: Record<string, AcpControlBarState>;
	get: (paneId: string) => AcpControlBarState;
	apply: (paneId: string, event: AcpPaneEvent) => void;
	seed: (paneId: string, options: AcpConfigOption[], seq: number) => void;
	mounted: (paneId: string) => void;
	started: (paneId: string, configId: string) => void;
	settled: (paneId: string, result: AcpSetConfigOptionResult) => void;
	failed: (paneId: string, message: string) => void;
	clear: (paneId: string) => void;
}

function update(
	paneId: string,
	transform: (state: AcpControlBarState) => AcpControlBarState,
) {
	return (store: { byPane: Record<string, AcpControlBarState> }) => ({
		byPane: {
			...store.byPane,
			[paneId]: transform(store.byPane[paneId] ?? emptyControlBar()),
		},
	});
}

export const useAcpControlBarStore = create<AcpControlBarStore>((set, get) => ({
	byPane: {},
	get: (paneId) => get().byPane[paneId] ?? emptyControlBar(),
	apply: (paneId, event) =>
		set(update(paneId, (state) => reduceControlBarEvent(state, event))),
	seed: (paneId, options, seq) =>
		set(update(paneId, (state) => seedOptions(state, options, seq))),
	mounted: (paneId) => set(update(paneId, paneMounted)),
	started: (paneId, configId) =>
		set(update(paneId, (state) => writeStarted(state, configId))),
	settled: (paneId, result) =>
		set(update(paneId, (state) => writeSettled(state, result))),
	failed: (paneId, message) =>
		set(update(paneId, (state) => writeFailed(state, message))),
	clear: (paneId) =>
		set((store) => {
			const byPane = { ...store.byPane };
			delete byPane[paneId];
			return { byPane };
		}),
}));
