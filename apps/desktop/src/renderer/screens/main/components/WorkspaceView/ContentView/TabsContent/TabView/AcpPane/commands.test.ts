/**
 * Phase 5 — the slash-command palette's whole decision, as pure functions.
 *
 * Written from `planning/PHASE_5_ACP_SLASH_PALETTE_DESIGN.md` rather than from
 * `commands.ts`: each `describe` below is one rule out of the design's "Tests"
 * list, and the design's own numbering (D2/D3/D5) is quoted where it applies.
 *
 * Two invariants everything here defends:
 *
 *   1. An EVENT always replaces the list; the mount seed applies only into an
 *      empty one (D2). `session/new` does not return commands, so a pane that
 *      remounts must be able to seed from the host cache — and a seed that
 *      could overwrite a live event would put a stale snapshot on screen.
 *   2. A command that leaves the list must leave the palette. That is the
 *      prove-it-fires case: a filter that quietly accumulated would look
 *      identical to a working one on every additive test in this file.
 *
 * The real 103-command capture is LOADED, never inlined — a transcription
 * asserts what I typed, and its >1 KB descriptions are the actual payload the
 * one-line rule has to survive.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AcpPaneEvent } from "lib/trpc/routers/acp";
import {
	type AcpCommand,
	acceptCommand,
	commandHint,
	commandSummary,
	emptyCommands,
	filterCommands,
	reduceCommandsEvent,
	seedCommands,
	slashQuery,
	useAcpCommandsStore,
} from "./commands";

// =============================================================================
// Helpers
// =============================================================================

function command(
	name: string,
	description = `${name} description`,
	hint?: string,
): AcpCommand {
	return hint ? { name, description, input: { hint } } : { name, description };
}

function commandsEvent(commands: AcpCommand[]): AcpPaneEvent {
	return {
		type: "update",
		update: { kind: "available_commands_update", commands },
	};
}

const EXIT: AcpPaneEvent = {
	type: "session_exit",
	code: 0,
	signal: null,
	expected: true,
};

function names(commands: AcpCommand[]): string[] {
	return commands.map((entry) => entry.name);
}

/**
 * Walk up from this file until the capture turns up, rather than hardcoding a
 * twelve-segment `../` chain that would break on a directory move and — far
 * worse — could silently resolve to another file of the same name. Same
 * resolver as `transcript.phase3.test.ts`.
 */
function repoFile(relative: string): string {
	let dir = import.meta.dir;
	for (let up = 0; up < 20; up += 1) {
		const candidate = join(dir, relative);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`could not locate ${relative} above ${import.meta.dir}`);
}

const CAPTURE_PATH = "planning/spikes/acp-phase3-capture/frames.json";

/** The one real `available_commands_update` frame in the Phase 3 capture. */
function capturedCommands(): AcpCommand[] {
	const raw: unknown = JSON.parse(readFileSync(repoFile(CAPTURE_PATH), "utf8"));
	if (!Array.isArray(raw)) throw new Error(`${CAPTURE_PATH} is not an array`);
	const frames = raw.filter(
		(frame): frame is { kind: string; commands: AcpCommand[] } =>
			(frame as { kind?: unknown })?.kind === "available_commands_update",
	);
	if (frames.length !== 1) {
		throw new Error(
			`${CAPTURE_PATH} holds ${frames.length} command frames, expected 1`,
		);
	}
	return frames[0]?.commands ?? [];
}

const CAPTURED = capturedCommands();

describe("the captured command list (population pin)", () => {
	it("is the 103-command list the design cites, with the two named skills", () => {
		// Asserted before anything is measured against it: if the capture is
		// ever re-recorded, the tests below are about a different population
		// and this is what says so out loud.
		expect(CAPTURED).toHaveLength(103);
		expect(names(CAPTURED)).toContain("wrap-up");
		expect(names(CAPTURED)).toContain("fable-orchestration");
	});
});

// =============================================================================
// filterCommands — D3 ordering
// =============================================================================

describe("filterCommands (D3)", () => {
	const LIST = [
		command("unwrap"),
		command("wrap-up"),
		command("rewrap"),
		command("wrapper"),
		command("init"),
	];

	it("puts prefix matches before substring matches", () => {
		// Ordering IS the behaviour: a filter that returned the same five names
		// in reported order would satisfy any "contains wrap-up" assertion
		// while burying the command the user is typing.
		expect(names(filterCommands(LIST, "wrap"))).toEqual([
			"wrap-up",
			"wrapper",
			"unwrap",
			"rewrap",
		]);
	});

	it("keeps reported order within each group", () => {
		expect(names(filterCommands(LIST, "rap"))).toEqual([
			"unwrap",
			"wrap-up",
			"rewrap",
			"wrapper",
		]);
	});

	it("is case-insensitive in both directions", () => {
		expect(names(filterCommands(LIST, "WRAP"))).toEqual(
			names(filterCommands(LIST, "wrap")),
		);
		expect(names(filterCommands([command("Wrap-Up")], "wrap"))).toEqual([
			"Wrap-Up",
		]);
	});

	it("returns the whole list for an empty query", () => {
		expect(filterCommands(LIST, "")).toEqual(LIST);
		expect(filterCommands(LIST, "   ")).toEqual(LIST);
	});

	it("returns nothing for a query that matches nothing", () => {
		// D3's "no matching commands" row is rendered from this empty array —
		// so empty must mean empty, not the unfiltered list.
		expect(filterCommands(LIST, "zzz")).toEqual([]);
	});

	it("returns an empty result for an empty list, at any query", () => {
		// D4: the palette that opens before any list arrived. The distinction
		// between "not loaded" and "no match" is the renderer's, but both
		// start from an empty array here.
		expect(filterCommands([], "wrap")).toEqual([]);
		expect(filterCommands([], "")).toEqual([]);
	});

	it("ranks the real capture the same way", () => {
		const filtered = filterCommands(CAPTURED, "wrap");
		expect(names(filtered)[0]).toBe("wrap-up");
		expect(filtered.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// The disappearance case — the prove-it-fires test
// =============================================================================

describe("a command removed from the list leaves the palette", () => {
	it("drops wrap-up when a second update omits it", () => {
		const withWrapUp = reduceCommandsEvent(
			emptyCommands(),
			commandsEvent(CAPTURED),
		);
		// Control: the assertion below can only mean something if the command
		// was there to begin with.
		expect(names(filterCommands(withWrapUp.commands, "wrap"))).toContain(
			"wrap-up",
		);

		const without = CAPTURED.filter((entry) => entry.name !== "wrap-up");
		expect(without).toHaveLength(102);

		const after = reduceCommandsEvent(withWrapUp, commandsEvent(without));

		// The deterministic stand-in for "disable a skill and watch it go".
		// A reducer that merged instead of replacing would pass every other
		// test in this file and fail only this one.
		expect(names(filterCommands(after.commands, "wrap"))).not.toContain(
			"wrap-up",
		);
		expect(after.commands).toHaveLength(102);
	});

	it("empties the palette on an empty update", () => {
		const seeded = reduceCommandsEvent(
			emptyCommands(),
			commandsEvent(CAPTURED),
		);
		const cleared = reduceCommandsEvent(seeded, commandsEvent([]));
		expect(cleared.commands).toEqual([]);
	});
});

// =============================================================================
// D2 — the seeding rule
// =============================================================================

describe("seeding rule (D2)", () => {
	it("seeds into an empty list", () => {
		const state = seedCommands(emptyCommands(), [command("wrap-up")]);
		expect(names(state.commands)).toEqual(["wrap-up"]);
	});

	it("ignores a seed once anything is held", () => {
		const live = reduceCommandsEvent(
			emptyCommands(),
			commandsEvent([command("fable-orchestration")]),
		);
		const seeded = seedCommands(live, [command("wrap-up"), command("stale")]);

		// The whole point of D2. The snapshot and the event stream are separate
		// IPC channels with nothing ordering them, so a seed that could
		// overwrite would put an already-superseded list on screen — and it
		// would look completely normal.
		expect(names(seeded.commands)).toEqual(["fable-orchestration"]);
		expect(seeded).toBe(live);
	});

	it("ignores an EMPTY seed over a populated list", () => {
		const live = reduceCommandsEvent(
			emptyCommands(),
			commandsEvent([command("wrap-up")]),
		);
		expect(names(seedCommands(live, []).commands)).toEqual(["wrap-up"]);
	});

	it("lets an event replace a seeded list", () => {
		const seeded = seedCommands(emptyCommands(), [command("old")]);
		const after = reduceCommandsEvent(
			seeded,
			commandsEvent([command("new-a"), command("new-b")]),
		);
		// An event ALWAYS wins, in the other direction too.
		expect(names(after.commands)).toEqual(["new-a", "new-b"]);
	});

	it("leaves state untouched for an unrelated update kind", () => {
		const live = reduceCommandsEvent(
			emptyCommands(),
			commandsEvent([command("wrap-up")]),
		);
		const after = reduceCommandsEvent(live, {
			type: "update",
			update: { kind: "agent_message_chunk", text: "hello" },
		});
		expect(after).toBe(live);
	});

	it("never throws, for any event type", () => {
		const live = reduceCommandsEvent(
			emptyCommands(),
			commandsEvent([command("wrap-up")]),
		);
		const others: AcpPaneEvent[] = [
			{ type: "turn_end", stopReason: "end_turn" },
			{ type: "turn_error", message: "boom" },
			{ type: "session_error", message: "boom" },
		];
		for (const event of others) {
			expect(reduceCommandsEvent(live, event)).toBe(live);
		}
	});
});

// =============================================================================
// D5 — session_exit clears
// =============================================================================

describe("session_exit clears the list (D5)", () => {
	it("empties a populated list", () => {
		const live = reduceCommandsEvent(emptyCommands(), commandsEvent(CAPTURED));
		expect(reduceCommandsEvent(live, EXIT).commands).toEqual([]);
	});

	it("leaves the cleared list seedable again", () => {
		const live = reduceCommandsEvent(
			emptyCommands(),
			commandsEvent([command("wrap-up")]),
		);
		const cleared = reduceCommandsEvent(live, EXIT);
		// D5's second half: the next session repopulates from its own state,
		// which only works because the clear left the list genuinely empty.
		expect(
			names(seedCommands(cleared, [command("next-session")]).commands),
		).toEqual(["next-session"]);
	});
});

// =============================================================================
// slashQuery — the trigger (D3)
// =============================================================================

describe("slashQuery trigger (D3)", () => {
	it("opens on a leading slash with the caret inside the token", () => {
		expect(slashQuery("/wrap", 5)).toBe("wrap");
		expect(slashQuery("/wrap", 3)).toBe("wrap");
		expect(slashQuery("/", 1)).toBe("");
	});

	it("does NOT open on a slash mid-text", () => {
		// A path, a date, a fraction. This is the case that would make the
		// palette pop open in the middle of an ordinary sentence.
		expect(slashQuery("see src/main.ts", 8)).toBeNull();
		expect(slashQuery("on 08/21 we shipped", 6)).toBeNull();
		expect(slashQuery(" /wrap", 3)).toBeNull();
	});

	it("stays shut with no text at all", () => {
		expect(slashQuery("", 0)).toBeNull();
		expect(slashQuery("hello", 5)).toBeNull();
	});

	it("respects the caret: before the slash does not count", () => {
		// Caret 0 sits BEFORE the `/`; the user has not entered the token yet.
		expect(slashQuery("/wrap", 0)).toBeNull();
	});

	it("respects the caret: past the token means arguments, not a command", () => {
		// `/wrap-up now` with the caret in `now` — the user is typing an
		// argument and a popover over it would be wrong.
		expect(slashQuery("/wrap-up now", 12)).toBeNull();
		expect(slashQuery("/wrap-up now", 9)).toBeNull();
		// The token's own end still counts: caret 8 is the last character of
		// `/wrap-up`, before the space.
		expect(slashQuery("/wrap-up now", 8)).toBe("wrap-up");
	});

	it("reports the whole leading token as the query", () => {
		// Deliberate: the caret gates OPEN/SHUT, and the query is the token,
		// not the text left of the caret. The design fixes the trigger rule
		// and leaves this unspecified, so it is pinned here as the choice made
		// rather than asserted as a requirement.
		expect(slashQuery("/wrap-up", 2)).toBe("wrap-up");
	});

	it("handles a token ended by a newline as well as a space", () => {
		expect(slashQuery("/wrap\nmore", 5)).toBe("wrap");
		expect(slashQuery("/wrap\nmore", 7)).toBeNull();
	});
});

// =============================================================================
// acceptCommand — D3 insertion
// =============================================================================

describe("acceptCommand (D3)", () => {
	it("inserts /name plus a trailing space when nothing follows", () => {
		// The trailing space is what closes the palette by its own trigger
		// rule — caret past the token end — instead of needing a separate
		// "just accepted" flag.
		expect(acceptCommand("/wr", "wrap-up")).toEqual({
			text: "/wrap-up ",
			caret: 9,
		});
		expect(slashQuery("/wrap-up ", 9)).toBeNull();
	});

	it("preserves arguments already typed, and does not add a space", () => {
		expect(acceptCommand("/wr the project", "wrap-up")).toEqual({
			text: "/wrap-up the project",
			caret: 9,
		});
	});

	it("replaces only the leading token, never the rest of the text", () => {
		expect(acceptCommand("/x a/b c/d", "dataviz").text).toBe(
			"/dataviz a/b c/d",
		);
	});

	it("works from a bare slash", () => {
		expect(acceptCommand("/", "wrap-up")).toEqual({
			text: "/wrap-up ",
			caret: 9,
		});
	});

	it("puts the caret after the inserted name", () => {
		const { text, caret } = acceptCommand("/f", "fable-orchestration");
		expect(text.slice(0, caret)).toBe("/fable-orchestration ");
	});
});

// =============================================================================
// commandSummary / commandHint — the one-line rule (D3)
// =============================================================================

describe("commandSummary (D3)", () => {
	const DATAVIZ = CAPTURED.find((entry) => entry.name === "dataviz");

	it("has a real >1 KB description to work on", () => {
		// The population pin for the truncation test: a short description
		// would exercise the pass-through branch and prove nothing.
		expect(DATAVIZ?.description.length).toBeGreaterThan(1000);
	});

	it("hard-truncates a >1 KB description to one short line", () => {
		const summary = commandSummary(DATAVIZ?.description);
		expect(summary.length).toBeLessThanOrEqual(120);
		expect(summary.endsWith("…")).toBe(true);
		// It is the START of the real description, not a placeholder.
		expect(DATAVIZ?.description.startsWith(summary.slice(0, -1))).toBe(true);
	});

	it("truncates every description in the real capture", () => {
		// Sweep, not a spot check: one un-truncated row is enough to push the
		// popover off the composer.
		for (const entry of CAPTURED) {
			const summary = commandSummary(entry.description);
			expect(summary.length).toBeLessThanOrEqual(120);
			expect(summary.includes("\n")).toBe(false);
		}
	});

	it("keeps a short description verbatim", () => {
		expect(commandSummary("End-of-session project hygiene")).toBe(
			"End-of-session project hygiene",
		);
	});

	it("takes the first line only, trimmed", () => {
		expect(commandSummary("  first line  \nsecond line\nthird")).toBe(
			"first line",
		);
	});

	it("renders a missing description as an empty string, not a crash", () => {
		expect(commandSummary(undefined)).toBe("");
		expect(commandSummary(null)).toBe("");
		expect(commandSummary("")).toBe("");
	});
});

describe("commandHint (D3)", () => {
	it("returns the declared hint", () => {
		expect(commandHint(command("last30days", "d", "last30days nvidia"))).toBe(
			"last30days nvidia",
		);
	});

	it("returns null when the command declares no input", () => {
		expect(commandHint(command("wrap-up"))).toBeNull();
	});

	it("reads the hint off the real capture", () => {
		const withHint = CAPTURED.filter((entry) => commandHint(entry) !== null);
		// Some commands carry a hint and some do not — the placeholder rule
		// depends on both halves existing in the real payload.
		expect(withHint.length).toBeGreaterThan(0);
		expect(withHint.length).toBeLessThan(CAPTURED.length);
	});
});

// =============================================================================
// The per-pane store
// =============================================================================

describe("useAcpCommandsStore", () => {
	it("keeps panes independent, and applies the same rules per pane", () => {
		const store = useAcpCommandsStore.getState();
		store.clear("pane-a");
		store.clear("pane-b");

		store.apply("pane-a", commandsEvent([command("wrap-up")]));
		store.seed("pane-b", [command("seeded")]);

		expect(
			names(useAcpCommandsStore.getState().get("pane-a").commands),
		).toEqual(["wrap-up"]);
		expect(
			names(useAcpCommandsStore.getState().get("pane-b").commands),
		).toEqual(["seeded"]);

		// D2 through the store: the seed is refused over a live event.
		store.seed("pane-a", [command("stale")]);
		expect(
			names(useAcpCommandsStore.getState().get("pane-a").commands),
		).toEqual(["wrap-up"]);

		// D5 through the store.
		store.apply("pane-a", EXIT);
		expect(useAcpCommandsStore.getState().get("pane-a").commands).toEqual([]);
		expect(
			names(useAcpCommandsStore.getState().get("pane-b").commands),
		).toEqual(["seeded"]);

		store.clear("pane-a");
		store.clear("pane-b");
	});

	it("returns an empty state for a pane it has never seen", () => {
		expect(useAcpCommandsStore.getState().get("pane-never")).toEqual(
			emptyCommands(),
		);
	});
});
