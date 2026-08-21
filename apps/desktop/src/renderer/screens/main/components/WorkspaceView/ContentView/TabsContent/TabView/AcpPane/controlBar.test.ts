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

function configUpdate(options: AcpConfigOption[]): AcpPaneEvent {
	return {
		type: "update",
		update: { kind: "config_option_update", options },
	};
}

function settled(
	options: AcpConfigOption[],
	applied: AcpSetConfigOptionResult["applied"],
): AcpSetConfigOptionResult {
	return { configOptions: options, applied };
}

// =============================================================================
// Seeding
// =============================================================================

describe("seed", () => {
	it("takes the reported list in the reported order", () => {
		const state = seedOptions(emptyControlBar(), [MODEL, EFFORT, FAST]);

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
		expect(seedOptions(emptyControlBar(), []).options).toEqual([]);
	});

	it("re-seeding replaces wholesale — it never merges the old list", () => {
		const first = seedOptions(emptyControlBar(), [MODEL, EFFORT]);
		const second = seedOptions(first, [MODEL]);

		expect(second.options.map((entry) => entry.id)).toEqual(["model"]);
	});
});

// =============================================================================
// Reconciling from the event stream
// =============================================================================

describe("reconcile from config_option_update", () => {
	it("adopts the reported values", () => {
		const seeded = seedOptions(emptyControlBar(), [MODEL, EFFORT]);
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
		const seeded = seedOptions(emptyControlBar(), [MODEL]);
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
		const seeded = seedOptions(emptyControlBar(), [MODEL, EFFORT, FAST]);
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
			seedOptions(emptyControlBar(), [MODEL, EFFORT]),
			"effort",
		);
		expect(inFlight.pending).toBe("effort");

		const state = reduceControlBarEvent(inFlight, configUpdate([MODEL]));

		expect(state.pending).toBeNull();
	});

	it("keeps pending when the update still reports that option", () => {
		// Positive control: an in-flight write must survive an unrelated update.
		const inFlight = writeStarted(
			seedOptions(emptyControlBar(), [MODEL, EFFORT]),
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
			writeStarted(seedOptions(emptyControlBar(), [MODEL, EFFORT]), "effort"),
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
			seedOptions(emptyControlBar(), [MODEL, EFFORT]),
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
		const seeded = seedOptions(emptyControlBar(), [MODEL]);
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
		const seeded = seedOptions(emptyControlBar(), [MODEL, EFFORT]);
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
			seedOptions(emptyControlBar(), [MODEL, EFFORT]),
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
			seedOptions(emptyControlBar(), [MODEL, EFFORT]),
			"model",
		);

		expect(
			state.options.find((entry) => entry.id === "model")?.currentValue,
		).toBe("default");
	});

	it("on settle it renders the READ-BACK truth, not the request", () => {
		const inFlight = writeStarted(
			seedOptions(emptyControlBar(), [MODEL, EFFORT]),
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
			seedOptions(emptyControlBar(), [MODEL, EFFORT]),
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
			seedOptions(emptyControlBar(), [MODEL]),
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
			seedOptions(emptyControlBar(), [MODEL]),
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
			seedOptions(emptyControlBar(), [MODEL, EFFORT]),
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
