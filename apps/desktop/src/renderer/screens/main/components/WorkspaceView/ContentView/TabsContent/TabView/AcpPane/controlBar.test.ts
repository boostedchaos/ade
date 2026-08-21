/**
 * The control bar reducer — Phase 4's whole rendering decision, as pure
 * functions, testable without React, Electron, IPC or an adapter.
 *
 * The invariant every test here defends: this state never holds a value the
 * USER asked for, only one the adapter reported back. The adapter answers a
 * config write with success for a value it silently resolved to something else
 * (design §Ground truth 2), so an optimistic control would display a lie and go
 * on displaying it.
 */

import { describe, expect, it } from "bun:test";
import type {
	AcpPaneEvent,
	AcpSetConfigOptionResult,
} from "lib/trpc/routers/acp";
import {
	type AcpConfigOption,
	controlKind,
	emptyControlBar,
	paneMounted,
	reduceControlBarEvent,
	seedOptions,
	switchValues,
	visibleControls,
	writeFailed,
	writeSettled,
	writeStarted,
} from "./controlBar";

function option(
	id: string,
	currentValue: string,
	valueIds: string[] = [],
	extra: Partial<AcpConfigOption> = {},
): AcpConfigOption {
	return {
		id,
		name: id,
		currentValue,
		values: valueIds.map((value) => ({ id: value, label: value })),
		...extra,
	};
}

const MODEL = option("model", "default", ["default", "haiku", "sonnet"]);
const EFFORT = option("effort", "medium", ["low", "medium", "high"]);
const FAST = option("fast", "off", ["on", "off"]);

/**
 * Every list the reducer accepts carries the host's cache generation. The
 * default is the same value everywhere, so a test that is not ABOUT ordering
 * behaves as it did before seq existed (equal seq is accepted).
 */
const SEQ = 1;

function configUpdate(
	options: AcpConfigOption[],
	seq: number = SEQ,
): AcpPaneEvent {
	return {
		type: "update",
		update: { kind: "config_option_update", options, seq },
	};
}

/**
 * `unverified` and `canonicalized` default to false — the ordinary settle. The
 * tests that are ABOUT them (A2/A4) set them explicitly.
 */
function settled(
	options: AcpConfigOption[],
	applied: Omit<
		AcpSetConfigOptionResult["applied"],
		"unverified" | "canonicalized"
	> &
		Partial<
			Pick<AcpSetConfigOptionResult["applied"], "unverified" | "canonicalized">
		>,
	seq: number = SEQ,
): AcpSetConfigOptionResult {
	return {
		configOptions: options,
		seq,
		applied: { unverified: false, canonicalized: false, ...applied },
	};
}

function currentValueOf(
	state: { options: AcpConfigOption[] },
	id: string,
): string | undefined {
	return state.options.find((entry) => entry.id === id)?.currentValue;
}

// =============================================================================
// Seeding
// =============================================================================

describe("seed", () => {
	it("takes the reported list in the reported order", () => {
		const state = seedOptions(emptyControlBar(), [MODEL, EFFORT, FAST], SEQ);

		expect(state.options.map((entry) => entry.id)).toEqual([
			"model",
			"effort",
			"fast",
		]);
		expect(state.pending).toBeNull();
		expect(state.mismatch).toBeNull();
		expect(state.error).toBeNull();
	});

	it("an empty seed leaves an empty bar rather than a placeholder", () => {
		expect(seedOptions(emptyControlBar(), [], SEQ).options).toEqual([]);
	});

	it("re-seeding replaces wholesale — it never merges the old list", () => {
		const first = seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ);
		const second = seedOptions(first, [MODEL], SEQ);

		expect(second.options.map((entry) => entry.id)).toEqual(["model"]);
	});
});

// =============================================================================
// Reconciling from the event stream
// =============================================================================

describe("reconcile from config_option_update", () => {
	it("adopts the reported values", () => {
		const seeded = seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ);
		const state = reduceControlBarEvent(
			seeded,
			configUpdate([option("model", "haiku", ["default", "haiku"]), EFFORT]),
		);

		expect(
			state.options.find((entry) => entry.id === "model")?.currentValue,
		).toBe("haiku");
	});

	it("adds an option that appeared on a model change", () => {
		// `effort` and `fast` come and go with the model (§Ground truth 4).
		const seeded = seedOptions(emptyControlBar(), [MODEL], SEQ);
		const state = reduceControlBarEvent(
			seeded,
			configUpdate([MODEL, EFFORT, FAST]),
		);

		expect(state.options.map((entry) => entry.id)).toEqual([
			"model",
			"effort",
			"fast",
		]);
	});

	it("D7: an option removed mid-session disappears from the bar", () => {
		const seeded = seedOptions(emptyControlBar(), [MODEL, EFFORT, FAST], SEQ);
		const state = reduceControlBarEvent(seeded, configUpdate([MODEL]));

		expect(state.options.map((entry) => entry.id)).toEqual(["model"]);
		expect(visibleControls(state.options).map((entry) => entry.id)).toEqual([
			"model",
		]);
	});

	it("a removed option drops its in-flight PENDING marker", () => {
		// The real race: the write is still on the wire when the adapter
		// announces the option is gone. A spinner on a control that no longer
		// exists would outlive its subject — and, having no settle to clear it,
		// would never come back.
		const inFlight = writeStarted(
			seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ),
			"effort",
		);
		expect(inFlight.pending).toBe("effort");

		const state = reduceControlBarEvent(inFlight, configUpdate([MODEL]));

		expect(state.pending).toBeNull();
	});

	it("keeps pending when the update still reports that option", () => {
		// Positive control: an in-flight write must survive an unrelated update.
		const inFlight = writeStarted(
			seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ),
			"effort",
		);

		const state = reduceControlBarEvent(
			inFlight,
			configUpdate([MODEL, EFFORT, FAST]),
		);

		expect(state.pending).toBe("effort");
	});

	it("a removed option drops its MISMATCH warning", () => {
		const mismatched = writeSettled(
			writeStarted(
				seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ),
				"effort",
			),
			settled([MODEL, EFFORT], {
				configId: "effort",
				requestedValue: "high",
				actualValue: "medium",
				verified: false,
			}),
		);
		expect(mismatched.mismatch?.configId).toBe("effort");

		const state = reduceControlBarEvent(mismatched, configUpdate([MODEL]));

		expect(state.mismatch).toBeNull();
	});

	it("keeps a mismatch whose option is still reported", () => {
		// Positive control for the test above: the clearing must be about
		// absence, not about any update arriving.
		const mismatched = writeSettled(
			seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ),
			settled([MODEL, EFFORT], {
				configId: "model",
				requestedValue: "fabl-typo",
				actualValue: "default",
				verified: false,
			}),
		);

		const state = reduceControlBarEvent(
			mismatched,
			configUpdate([MODEL, EFFORT]),
		);

		expect(state.mismatch?.configId).toBe("model");
	});

	it("ignores every other event kind", () => {
		const seeded = seedOptions(emptyControlBar(), [MODEL], SEQ);
		const untouched: AcpPaneEvent[] = [
			{ type: "update", update: { kind: "agent_message_chunk", text: "hi" } },
			{ type: "turn_end", stopReason: "end_turn" },
			{ type: "turn_error", message: "boom" },
			{ type: "session_error", message: "boom" },
		];

		for (const event of untouched) {
			expect(reduceControlBarEvent(seeded, event)).toBe(seeded);
		}
	});

	it("clears the bar when the session exits", () => {
		const seeded = seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ);
		const state = reduceControlBarEvent(seeded, {
			type: "session_exit",
			code: 1,
			signal: null,
			expected: false,
		});

		expect(state).toEqual(emptyControlBar());
	});
});

// =============================================================================
// In-flight → settle
// =============================================================================

describe("write lifecycle", () => {
	it("marks the written option pending and clears prior warnings", () => {
		const dirty = writeFailed(
			seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ),
			"acp-invalid-config-value: nope",
		);

		const state = writeStarted(dirty, "model");

		expect(state.pending).toBe("model");
		expect(state.error).toBeNull();
		expect(state.mismatch).toBeNull();
	});

	it("does NOT show the requested value while the write is in flight", () => {
		// The whole point of the no-optimism rule: mid-flight the bar still
		// renders the last value the adapter reported.
		const state = writeStarted(
			seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ),
			"model",
		);

		expect(
			state.options.find((entry) => entry.id === "model")?.currentValue,
		).toBe("default");
	});

	it("on settle it renders the READ-BACK truth, not the request", () => {
		const inFlight = writeStarted(
			seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ),
			"model",
		);

		const state = writeSettled(
			inFlight,
			settled(
				[option("model", "sonnet", ["default", "haiku", "sonnet"]), EFFORT],
				{
					configId: "model",
					requestedValue: "sonnet",
					actualValue: "sonnet",
					verified: true,
				},
			),
		);

		expect(state.pending).toBeNull();
		expect(state.mismatch).toBeNull();
		expect(
			state.options.find((entry) => entry.id === "model")?.currentValue,
		).toBe("sonnet");
	});

	it("a settle can also add and remove controls in one step", () => {
		// The read-back is a whole-list replacement, so a model switch that
		// dropped `effort` shows up here and not only on the event stream.
		const inFlight = writeStarted(
			seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ),
			"model",
		);

		const state = writeSettled(
			inFlight,
			settled([option("model", "haiku", ["haiku"]), FAST], {
				configId: "model",
				requestedValue: "haiku",
				actualValue: "haiku",
				verified: true,
			}),
		);

		expect(state.options.map((entry) => entry.id)).toEqual(["model", "fast"]);
	});

	it("verified:false records the mismatch WITH the value that actually landed", () => {
		const inFlight = writeStarted(
			seedOptions(emptyControlBar(), [MODEL], SEQ),
			"model",
		);

		const state = writeSettled(
			inFlight,
			settled([option("model", "default", ["default", "haiku"])], {
				configId: "model",
				requestedValue: "fabl-5-typo",
				actualValue: "default",
				verified: false,
			}),
		);

		expect(state.mismatch).toEqual({
			configId: "model",
			requestedValue: "fabl-5-typo",
			actualValue: "default",
		});
		// And the displayed value is the adapter's, never the typed one.
		expect(
			state.options.find((entry) => entry.id === "model")?.currentValue,
		).toBe("default");
		expect(state.pending).toBeNull();
	});

	it("a later verified write clears the earlier mismatch", () => {
		const mismatched = writeSettled(
			seedOptions(emptyControlBar(), [MODEL], SEQ),
			settled([option("model", "default", ["default", "haiku"])], {
				configId: "model",
				requestedValue: "fabl-5-typo",
				actualValue: "default",
				verified: false,
			}),
		);

		const state = writeSettled(
			writeStarted(mismatched, "model"),
			settled([option("model", "haiku", ["default", "haiku"])], {
				configId: "model",
				requestedValue: "haiku",
				actualValue: "haiku",
				verified: true,
			}),
		);

		expect(state.mismatch).toBeNull();
	});

	it("a failed write clears pending and keeps the message verbatim", () => {
		const inFlight = writeStarted(
			seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ),
			"effort",
		);

		const state = writeFailed(inFlight, "acp-invalid-config-value: ludicrous");

		expect(state.pending).toBeNull();
		expect(state.error).toBe("acp-invalid-config-value: ludicrous");
		// The list is untouched: a refused write changed nothing on the wire.
		expect(state.options.map((entry) => entry.id)).toEqual(["model", "effort"]);
	});
});

// =============================================================================
// D6 — which controls render, and in what order
// =============================================================================

describe("visibleControls (D6)", () => {
	it("excludes `mode` by id", () => {
		const options = [option("mode", "default", ["default", "plan"]), MODEL];

		expect(visibleControls(options).map((entry) => entry.id)).toEqual([
			"model",
		]);
	});

	it("excludes an option whose CATEGORY is mode, whatever its id", () => {
		const options = [
			option("permission_policy", "default", ["default"], {
				category: "mode",
			}),
			MODEL,
		];

		expect(visibleControls(options).map((entry) => entry.id)).toEqual([
			"model",
		]);
	});

	it("orders model → effort → fast → agent regardless of reported order", () => {
		const options = [
			option("agent", "none", ["none"]),
			FAST,
			option("mode", "default", ["default"]),
			EFFORT,
			MODEL,
		];

		expect(visibleControls(options).map((entry) => entry.id)).toEqual([
			"model",
			"effort",
			"fast",
			"agent",
		]);
	});

	it("renders unknown options LAST, in reported order", () => {
		const options = [
			option("zebra", "1", ["1"]),
			option("apple", "1", ["1"]),
			MODEL,
		];

		expect(visibleControls(options).map((entry) => entry.id)).toEqual([
			"model",
			"zebra",
			"apple",
		]);
	});

	it("renders nothing when only excluded options are reported", () => {
		expect(visibleControls([option("mode", "default", ["default"])])).toEqual(
			[],
		);
	});
});

// =============================================================================
// D6 — control kinds
// =============================================================================

describe("controlKind", () => {
	it("model is the combobox", () => {
		expect(controlKind(MODEL)).toBe("model");
	});

	it("an on/off two-value select is a switch", () => {
		expect(controlKind(FAST)).toBe("switch");
		expect(switchValues(FAST)).toEqual({ on: "on", off: "off" });
	});

	it("a true/false pair — the host's boolean shape — is a switch too", () => {
		const boolean = option("fast", "false", ["true", "false"]);

		expect(controlKind(boolean)).toBe("switch");
		expect(switchValues(boolean)).toEqual({ on: "true", off: "false" });
	});

	it("a two-value select that is NOT on/off stays a plain select", () => {
		// The control-test: two values alone must not make a switch, or a
		// two-model list would render as a toggle.
		expect(controlKind(option("agent", "a", ["a", "b"]))).toBe("select");
	});

	it("a multi-value select is a plain select", () => {
		expect(controlKind(EFFORT)).toBe("select");
	});

	it("a free-form option with no declared values is a plain select", () => {
		expect(controlKind(option("freeform", ""))).toBe("select");
	});
});

// =============================================================================
// F1 / A1 — two unordered IPC channels carry config truth
// =============================================================================

/**
 * The bar hears about config from two places that are not ordered against each
 * other: the `config_option_update` subscription and a mutation's own return
 * value. Adapter 0.63.0 DOES emit `config_option_update` mid-turn (its
 * fast-mode sync fires one from the turn-result handler), so a read-back that
 * was already on the wire can land AFTER a newer update and put the bar back to
 * a value the adapter has already abandoned.
 *
 * Every list therefore carries the host's cache generation, and a list older
 * than the one held is refused.
 */
describe("seq ordering (A1)", () => {
	const FAST_ON = option("fast", "on", ["on", "off"]);
	const FAST_OFF = option("fast", "off", ["on", "off"]);

	it("F1: a stale read-back cannot undo a newer config_option_update", () => {
		const seeded = seedOptions(emptyControlBar(), [FAST_ON], 3);

		// Mid-turn, the adapter turns fast mode off and says so (generation 4).
		const afterUpdate = reduceControlBarEvent(
			seeded,
			configUpdate([FAST_OFF], 4),
		);
		expect(currentValueOf(afterUpdate, "fast")).toBe("off");

		// The read-back that was already in flight when that happened settles
		// now, carrying the pre-change list it read at generation 3.
		const state = writeSettled(
			writeStarted(afterUpdate, "fast"),
			settled(
				[FAST_ON],
				{
					configId: "fast",
					requestedValue: "on",
					actualValue: "on",
					verified: true,
					unverified: false,
					canonicalized: false,
				},
				3,
			),
		);

		expect(currentValueOf(state, "fast")).toBe("off");
		expect(state.seq).toBe(4);
		// The mutation still settled: refusing its LIST must not strand the
		// control disabled with a spinner.
		expect(state.pending).toBeNull();
	});

	it("POSITIVE CONTROL: a newer read-back is applied", () => {
		// Same machinery, higher seq. Without this, a reducer that refused
		// every settle would pass the test above.
		const seeded = seedOptions(emptyControlBar(), [FAST_OFF], 4);

		const state = writeSettled(
			writeStarted(seeded, "fast"),
			settled(
				[FAST_ON],
				{
					configId: "fast",
					requestedValue: "on",
					actualValue: "on",
					verified: true,
					unverified: false,
					canonicalized: false,
				},
				5,
			),
		);

		expect(currentValueOf(state, "fast")).toBe("on");
		expect(state.seq).toBe(5);
	});

	it("refuses a stale config_option_update too, not just a stale settle", () => {
		const seeded = seedOptions(emptyControlBar(), [FAST_OFF], 6);

		const state = reduceControlBarEvent(seeded, configUpdate([FAST_ON], 5));

		expect(currentValueOf(state, "fast")).toBe("off");
		expect(state.seq).toBe(6);
	});

	it("refuses a stale SEED — a remount's cached list can be older too", () => {
		const seeded = seedOptions(emptyControlBar(), [FAST_OFF], 6);

		const state = seedOptions(seeded, [FAST_ON], 2);

		expect(currentValueOf(state, "fast")).toBe("off");
	});

	it("a fresh pane holds seq 0, so the first mount seed always lands", () => {
		expect(emptyControlBar().seq).toBe(0);

		const state = seedOptions(emptyControlBar(), [FAST_ON], 1);

		expect(currentValueOf(state, "fast")).toBe("on");
		expect(state.seq).toBe(1);
	});

	it("accepts an EQUAL seq — a re-seed of the same generation is harmless", () => {
		const seeded = seedOptions(emptyControlBar(), [FAST_OFF], 4);
		const state = seedOptions(seeded, [FAST_ON], 4);

		expect(currentValueOf(state, "fast")).toBe("on");
	});
});

// =============================================================================
// F2 / A2 — "could not verify" is its own state
// =============================================================================

describe("unverified settle (A2)", () => {
	function applied(
		overrides: Partial<AcpSetConfigOptionResult["applied"]>,
	): AcpSetConfigOptionResult["applied"] {
		return {
			configId: "model",
			requestedValue: "haiku",
			actualValue: "haiku",
			verified: false,
			unverified: false,
			canonicalized: false,
			...overrides,
		};
	}

	it("F2: an unverified settle is neither a green settle nor a mismatch", () => {
		const state = writeSettled(
			writeStarted(seedOptions(emptyControlBar(), [MODEL], SEQ), "model"),
			settled([MODEL], applied({ unverified: true })),
		);

		expect(state.unverified).toEqual({
			configId: "model",
			requestedValue: "haiku",
		});
		expect(state.mismatch).toBeNull();
		expect(state.pending).toBeNull();
	});

	it("a verified settle clears an earlier could-not-verify", () => {
		const stale = writeSettled(
			seedOptions(emptyControlBar(), [MODEL], SEQ),
			settled([MODEL], applied({ unverified: true })),
		);
		expect(stale.unverified).not.toBeNull();

		const state = writeSettled(
			writeStarted(stale, "model"),
			settled([MODEL], applied({ verified: true })),
		);

		expect(state.unverified).toBeNull();
		expect(state.mismatch).toBeNull();
	});

	it("a mismatched settle clears an earlier could-not-verify", () => {
		const stale = writeSettled(
			seedOptions(emptyControlBar(), [MODEL], SEQ),
			settled([MODEL], applied({ unverified: true })),
		);

		const state = writeSettled(
			writeStarted(stale, "model"),
			settled([MODEL], applied({ actualValue: "default" })),
		);

		expect(state.unverified).toBeNull();
		expect(state.mismatch?.actualValue).toBe("default");
	});

	it("an option that vanished takes its could-not-verify with it", () => {
		const stale = writeSettled(
			seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ),
			settled(
				[MODEL, EFFORT],
				applied({ configId: "effort", unverified: true }),
			),
		);
		expect(stale.unverified?.configId).toBe("effort");

		const state = reduceControlBarEvent(stale, configUpdate([MODEL]));

		expect(state.unverified).toBeNull();
	});

	// -------------------------------------------------------------------------
	// A4 — the chip distinguishes canonicalization from substitution
	// -------------------------------------------------------------------------

	it("F4: a canonicalized alias records NO mismatch", () => {
		const state = writeSettled(
			writeStarted(seedOptions(emptyControlBar(), [MODEL], SEQ), "model"),
			settled(
				[option("model", "claude-opus-5", ["claude-opus-5"])],
				applied({
					requestedValue: "opus",
					actualValue: "claude-opus-5",
					canonicalized: true,
				}),
			),
		);

		expect(state.mismatch).toBeNull();
		expect(state.unverified).toBeNull();
	});

	it("PROVES THE CHECK FIRES: an un-canonicalized substitution still records one", () => {
		const state = writeSettled(
			writeStarted(seedOptions(emptyControlBar(), [MODEL], SEQ), "model"),
			settled(
				[option("model", "claude-opus-5", ["claude-opus-5"])],
				applied({
					requestedValue: "claude-haiku-99",
					actualValue: "claude-opus-5",
					canonicalized: false,
				}),
			),
		);

		expect(state.mismatch).toEqual({
			configId: "model",
			requestedValue: "claude-haiku-99",
			actualValue: "claude-opus-5",
		});
	});
});

// =============================================================================
// F3 / A3 — nothing latches
// =============================================================================

describe("pending never latches (A3)", () => {
	it("F3: a remount clears a pending write that has no observer left to settle it", () => {
		// TanStack Query v5 does not call a per-call onSuccess/onError after the
		// observer unmounts, so a write in flight when the pane unmounted has
		// nothing left to settle it. `pending` disables the WHOLE bar, and with
		// no spinner and no error the pane comes back permanently inert.
		const inFlight = writeStarted(
			seedOptions(emptyControlBar(), [MODEL, EFFORT], SEQ),
			"model",
		);

		const state = paneMounted(inFlight);

		expect(state.pending).toBeNull();
		// The options survive: the bar re-renders from what it already knows
		// while the mount's own read-back is on the wire.
		expect(state.options.map((entry) => entry.id)).toEqual(["model", "effort"]);
	});

	it("F3: session_error clears pending, the way session_exit already does", () => {
		// The child can report a fatal error without exiting; only `session_exit`
		// cleared pending, so that path left the bar disabled forever.
		const inFlight = writeStarted(
			seedOptions(emptyControlBar(), [MODEL], SEQ),
			"model",
		);

		const state = reduceControlBarEvent(inFlight, {
			type: "session_error",
			message: "acp-session-died: exited (code 1, signal null) mid-turn",
		});

		expect(state.pending).toBeNull();
	});

	it("session_error keeps the reported options — it is not a session exit", () => {
		const inFlight = writeStarted(
			seedOptions(emptyControlBar(), [MODEL], SEQ),
			"model",
		);

		const state = reduceControlBarEvent(inFlight, {
			type: "session_error",
			message: "boom",
		});

		expect(state.options.map((entry) => entry.id)).toEqual(["model"]);
	});

	it("a mount with nothing in flight changes nothing", () => {
		// Positive control: clearing must be about a stranded write, not
		// something every mount does to state that is already correct.
		const seeded = seedOptions(emptyControlBar(), [MODEL], SEQ);

		expect(paneMounted(seeded)).toBe(seeded);
	});
});
