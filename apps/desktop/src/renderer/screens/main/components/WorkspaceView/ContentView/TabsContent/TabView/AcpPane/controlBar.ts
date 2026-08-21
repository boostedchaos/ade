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

export interface AcpControlBarState {
	/** Read-back truth, in the order the adapter reported it. */
	options: AcpConfigOption[];
	/** The option whose write is on the wire; its control is disabled. */
	pending: string | null;
	/** Set when a read-back reported a value other than the requested one. */
	mismatch: AcpControlBarMismatch | null;
	/** Last write failure, verbatim. */
	error: string | null;
}

export function emptyControlBar(): AcpControlBarState {
	return { options: [], pending: null, mismatch: null, error: null };
}

/**
 * Options the adapter no longer reports take their pending and mismatch state
 * with them: both name a control that is about to stop existing (D7), and a
 * warning chip with nothing to hang off would outlive its subject.
 */
function withOptions(
	state: AcpControlBarState,
	options: AcpConfigOption[],
): AcpControlBarState {
	const present = new Set(options.map((option) => option.id));
	return {
		...state,
		options,
		pending: state.pending && present.has(state.pending) ? state.pending : null,
		mismatch:
			state.mismatch && present.has(state.mismatch.configId)
				? state.mismatch
				: null,
	};
}

/** Seed from `acp.state` on mount, or from an `acp.readConfig` read-back. */
export function seedOptions(
	state: AcpControlBarState,
	options: AcpConfigOption[],
): AcpControlBarState {
	return withOptions(state, options);
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
				? withOptions(state, event.update.options)
				: state;
		case "session_exit":
			return emptyControlBar();
		default:
			return state;
	}
}

export function writeStarted(
	state: AcpControlBarState,
	configId: string,
): AcpControlBarState {
	return { ...state, pending: configId, mismatch: null, error: null };
}

export function writeSettled(
	state: AcpControlBarState,
	result: AcpSetConfigOptionResult,
): AcpControlBarState {
	const next = withOptions(state, result.configOptions);
	const { applied } = result;
	return {
		...next,
		pending: null,
		mismatch: applied.verified
			? null
			: {
					configId: applied.configId,
					requestedValue: applied.requestedValue,
					actualValue: applied.actualValue,
				},
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
	seed: (paneId: string, options: AcpConfigOption[]) => void;
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
	seed: (paneId, options) =>
		set(update(paneId, (state) => seedOptions(state, options))),
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
