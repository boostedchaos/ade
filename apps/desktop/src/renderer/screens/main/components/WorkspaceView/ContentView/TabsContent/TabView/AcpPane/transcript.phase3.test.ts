/**
 * Phase 3 (D1) — the widened transcript reducer, tested against the design doc
 * `planning/PHASE_3_ACP_RICH_RENDERING_DESIGN.md` rather than against the
 * implementation.
 *
 * The load-bearing test is the first one: a verbatim replay of the 43-frame
 * live capture (`planning/spikes/acp-phase3-capture/frames.json`), whose
 * expected output D6 states exactly — three tool cards (Read alpha.txt / Read
 * beta.txt / Edit beta.txt), all `completed`, the edit carrying a diff, usage
 * `43397/1000000`, lastCost `0.670733`. The file is LOADED, never inlined: a
 * copy pasted into a test asserts what I transcribed, not what the wire sent,
 * and would keep passing after the capture is re-recorded.
 *
 * Everything below it is a rule from the design's "Tests" list, one describe
 * per rule.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AcpPaneEvent } from "lib/trpc/routers/acp";
import {
	type AcpEntry,
	type AcpToolEntry,
	type AcpTranscript,
	appendUserPrompt,
	emptyTranscript,
	reduceAcpEvent,
} from "./transcript";

type AcpUpdate = Extract<AcpPaneEvent, { type: "update" }>["update"];

// =============================================================================
// Helpers
// =============================================================================

function update(u: AcpUpdate): AcpPaneEvent {
	return { type: "update", update: u };
}

function chunk(text: string): AcpPaneEvent {
	return update({ kind: "agent_message_chunk", text });
}

function thought(text: string): AcpPaneEvent {
	return update({ kind: "agent_thought_chunk", text });
}

function play(events: AcpPaneEvent[], from = emptyTranscript()): AcpTranscript {
	return events.reduce(reduceAcpEvent, from);
}

function toolEntries(state: AcpTranscript): AcpToolEntry[] {
	return state.entries.filter(
		(entry): entry is AcpToolEntry => entry.role === "tool",
	);
}

/**
 * Walk up from this file until the capture turns up, rather than hardcoding a
 * twelve-segment `../` chain that would break on any directory move and — far
 * worse — could silently resolve to some other file of the same name.
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

function loadCapturedFrames(): AcpUpdate[] {
	const raw: unknown = JSON.parse(readFileSync(repoFile(CAPTURE_PATH), "utf8"));
	if (!Array.isArray(raw)) throw new Error(`${CAPTURE_PATH} is not an array`);
	for (const frame of raw) {
		if (typeof (frame as { kind?: unknown })?.kind !== "string") {
			throw new Error(`${CAPTURE_PATH} has a frame with no string kind`);
		}
	}
	// The capture is what `AcpHost` emitted, i.e. already through
	// `mapSessionUpdate` — so each frame IS an `AcpSessionUpdate`. The cast is
	// the only untyped step, and the shape check above is what backs it.
	return raw as AcpUpdate[];
}

// =============================================================================
// D6 — the live capture, replayed verbatim
// =============================================================================

describe("D6 — frames.json replay", () => {
	const frames = loadCapturedFrames();
	const events = frames.map(update);
	const state = play(events);

	it("reads the real capture, not a transcription of it", () => {
		// If the file ever stops being the 43-frame read-read-edit turn the
		// design cites, every expectation below is measuring something else —
		// so the population is asserted before the metric.
		expect(frames).toHaveLength(43);
		const kinds = frames.reduce<Record<string, number>>((counts, frame) => {
			counts[frame.kind] = (counts[frame.kind] ?? 0) + 1;
			return counts;
		}, {});
		expect(kinds).toEqual({
			available_commands_update: 1,
			usage_update: 8,
			agent_message_chunk: 20,
			tool_call: 3,
			tool_call_update: 11,
		});
	});

	it("produces exactly three tool cards", () => {
		expect(toolEntries(state)).toHaveLength(3);
	});

	it("lands each card on its refined title, all completed", () => {
		expect(
			toolEntries(state).map((entry) => [
				entry.call.title,
				entry.call.status,
				entry.call.kind,
				entry.call.toolName,
			]),
		).toEqual([
			["Read alpha.txt", "completed", "read", "Read"],
			["Read beta.txt", "completed", "read", "Read"],
			["Edit beta.txt", "completed", "edit", "Edit"],
		]);
	});

	it("never leaves a card on the generic opening title", () => {
		// The opening frames say "Read File" / "Edit"; a merge that dropped the
		// refinement would still show three completed cards.
		const titles = toolEntries(state).map((entry) => entry.call.title);
		expect(titles).not.toContain("Read File");
		expect(titles).not.toContain("Edit");
	});

	it("marks no card synthetic — every id was announced by a tool_call", () => {
		expect(toolEntries(state).map((entry) => entry.synthetic ?? false)).toEqual(
			[false, false, false],
		);
	});

	it("carries ONE diff on the edit card, not the two the wire sent", () => {
		// The duplicate-diff regression: frames 21 and 23 each carry a whole
		// diff for the same call (the second from the PostToolUse hook). Content
		// REPLACES, so the last one wins and the card shows one edit.
		const edit = toolEntries(state)[2];
		expect(edit?.call.content).toHaveLength(1);
		expect(edit?.call.content?.[0]).toMatchObject({
			type: "diff",
			oldText: "beta line 1\nbeta line 2",
			newText: "beta line 1\nbeta line 2 EDITED",
		});
	});

	it("keeps the read cards' text output", () => {
		expect(toolEntries(state)[0]?.call.content).toEqual([
			{
				type: "content",
				content: {
					type: "text",
					text: "```\n1\talpha line 1\n2\talpha line 2\n```",
				},
			},
		]);
	});

	it("ends on the last usage frame and retains the turn-final cost", () => {
		expect(state.usage).toEqual({
			used: 43397,
			size: 1000000,
			cost: { amount: 0.670733, currency: "USD" },
		});
		expect(state.lastCost).toEqual({ amount: 0.670733, currency: "USD" });
	});

	it("orders entries as they arrived: text, three cards, then text", () => {
		expect(state.entries.map((entry) => entry.role)).toEqual([
			"assistant",
			"tool",
			"tool",
			"tool",
			"assistant",
		]);
		expect(state.entries[0]?.text).toBe("I will read both files now.");
		expect(state.entries[4]?.text).toBe(
			'DONE\n\nI read both files. Then I changed line 2 of `beta.txt` to "beta line 2 EDITED". The edit was good. You do not have to do anything.',
		);
	});

	it("counts only the one kind Phase 3 still ignores", () => {
		expect(state.ignoredKinds).toEqual({ available_commands_update: 1 });
	});

	it("saw no plan and no thinking in this turn, and says so honestly", () => {
		// Ground truth 4/5: the capture contains zero thought frames and zero
		// plan frames. `null` here is the absence of evidence, not a default.
		expect(state.plan).toBeNull();
		expect(
			state.entries.some((entry) => entry.role === "thinking"),
		).toBeFalse();
	});
});

// =============================================================================
// D1 — sparse merge
// =============================================================================

describe("D1 — sparse tool-call merge", () => {
	const opened = update({
		kind: "tool_call",
		toolCall: {
			toolCallId: "t1",
			title: "Read File",
			kind: "read",
			status: "pending",
			content: [],
			locations: [],
			rawInput: { file_path: "/a.txt" },
			_meta: { claudeCode: { toolName: "Read" } },
		},
	});

	it("leaves an ABSENT field unchanged", () => {
		const state = play([
			opened,
			update({
				kind: "tool_call_update",
				toolCall: { toolCallId: "t1", status: "completed" },
			}),
		]);
		const call = toolEntries(state)[0]?.call;
		expect(call?.status).toBe("completed");
		expect(call?.title).toBe("Read File");
		expect(call?.kind).toBe("read");
		expect(call?.toolName).toBe("Read");
		expect(call?.rawInput).toEqual({ file_path: "/a.txt" });
	});

	it("treats an explicit NULL as unchanged, not as a clear", () => {
		// The protocol says omitting a field and sending null both mean "leave
		// it" (ToolCallUpdate, `name`). A merge that assigned null would blank a
		// title the user is reading.
		const state = play([
			opened,
			update({
				kind: "tool_call_update",
				toolCall: {
					toolCallId: "t1",
					title: null,
					kind: null,
					status: null,
					content: null,
					locations: null,
					name: null,
				},
			}),
		]);
		expect(toolEntries(state)[0]?.call).toMatchObject({
			title: "Read File",
			kind: "read",
			status: "pending",
			content: [],
			locations: [],
			toolName: "Read",
		});
	});

	it("REPLACES content rather than appending it", () => {
		const diff = (newText: string) => ({
			type: "diff" as const,
			path: "/b.txt",
			oldText: "one",
			newText,
		});
		const state = play([
			opened,
			update({
				kind: "tool_call_update",
				toolCall: {
					toolCallId: "t1",
					content: [diff("first")],
				},
			}),
			update({
				kind: "tool_call_update",
				toolCall: {
					toolCallId: "t1",
					content: [diff("second")],
				},
			}),
		]);
		expect(toolEntries(state)[0]?.call.content).toEqual([diff("second")]);
	});

	it("REPLACES locations rather than appending them", () => {
		const state = play([
			opened,
			update({
				kind: "tool_call_update",
				toolCall: {
					toolCallId: "t1",
					locations: [{ path: "/a.txt", line: 1 }],
				},
			}),
			update({
				kind: "tool_call_update",
				toolCall: {
					toolCallId: "t1",
					locations: [{ path: "/b.txt" }],
				},
			}),
		]);
		expect(toolEntries(state)[0]?.call.locations).toEqual([{ path: "/b.txt" }]);
	});

	it("never invents a field no frame carried", () => {
		const state = play([
			update({
				kind: "tool_call",
				toolCall: {
					toolCallId: "bare",
					title: "Something",
				},
			}),
		]);
		const call = toolEntries(state)[0]?.call;
		expect(call).toEqual({ toolCallId: "bare", title: "Something" });
		expect(call && "status" in call).toBeFalse();
		expect(call && "content" in call).toBeFalse();
	});

	it("reads the tool name out of _meta, where the wire actually puts it", () => {
		// Ground truth 2: `ToolCall.name` is never set; the programmatic name
		// lives in `_meta.claudeCode.toolName`.
		const state = play([
			update({
				kind: "tool_call",
				toolCall: {
					toolCallId: "t9",
					title: "Edit",
					_meta: { claudeCode: { toolName: "Edit" } },
				},
			}),
		]);
		expect(toolEntries(state)[0]?.call.toolName).toBe("Edit");
	});

	it("correlates on toolCallId only — two ids are two cards", () => {
		const state = play([
			opened,
			update({
				kind: "tool_call",
				toolCall: {
					toolCallId: "t2",
					title: "Read File",
					status: "pending",
				},
			}),
			update({
				kind: "tool_call_update",
				toolCall: {
					toolCallId: "t2",
					title: "Read beta.txt",
				},
			}),
		]);
		expect(toolEntries(state).map((e) => e.call.title)).toEqual([
			"Read File",
			"Read beta.txt",
		]);
	});
});

// =============================================================================
// D1 — the orphan update
// =============================================================================

describe("D1 — orphan tool_call_update", () => {
	it("CREATES a card for an id no tool_call announced, marked synthetic", () => {
		const state = play([
			update({
				kind: "tool_call_update",
				toolCall: {
					toolCallId: "ghost",
					title: "Edit ghost.txt",
					status: "completed",
				},
			}),
		]);
		expect(toolEntries(state)).toHaveLength(1);
		expect(toolEntries(state)[0]).toMatchObject({
			role: "tool",
			toolCallId: "ghost",
			synthetic: true,
			call: { title: "Edit ghost.txt", status: "completed" },
		});
	});

	it("does not mark a card synthetic when tool_call opened it", () => {
		const state = play([
			update({
				kind: "tool_call",
				toolCall: {
					toolCallId: "real",
					title: "Read File",
				},
			}),
		]);
		expect(toolEntries(state)[0]?.synthetic).toBeUndefined();
	});

	it("merges later updates into the synthetic card rather than duplicating", () => {
		const state = play([
			update({
				kind: "tool_call_update",
				toolCall: {
					toolCallId: "ghost",
					title: "Edit ghost.txt",
				},
			}),
			update({
				kind: "tool_call_update",
				toolCall: {
					toolCallId: "ghost",
					status: "completed",
				},
			}),
		]);
		expect(toolEntries(state)).toHaveLength(1);
		expect(toolEntries(state)[0]?.call.status).toBe("completed");
	});
});

// =============================================================================
// D1 — thinking
// =============================================================================

describe("D1 — thinking entries", () => {
	it("appends consecutive thought chunks into one entry", () => {
		const state = play([thought("I should "), thought("read the file.")]);
		expect(state.entries).toHaveLength(1);
		expect(state.entries[0]).toMatchObject({
			role: "thinking",
			text: "I should read the file.",
		});
	});

	it("closes the block when a message chunk arrives, and opens a new one later", () => {
		const state = play([thought("first"), chunk("reply"), thought("second")]);
		expect(
			state.entries.map((entry: AcpEntry) => [entry.role, entry.text]),
		).toEqual([
			["thinking", "first"],
			["assistant", "reply"],
			["thinking", "second"],
		]);
	});

	it("closes the block when a tool call arrives", () => {
		const state = play([
			thought("first"),
			update({
				kind: "tool_call",
				toolCall: { toolCallId: "t1", title: "Read File" },
			}),
			thought("second"),
		]);
		expect(state.entries.map((entry) => entry.role)).toEqual([
			"thinking",
			"tool",
			"thinking",
		]);
	});

	it("closes the block at turn end", () => {
		const state = play([
			thought("mid-turn"),
			{ type: "turn_end", stopReason: "end_turn" },
		]);
		expect(state.openThinkingIndex).toBeNull();
		const later = play([thought("next turn")], state);
		expect(later.entries.filter((e) => e.role === "thinking")).toHaveLength(2);
	});

	it("closes the open assistant entry first, so order is arrival order", () => {
		// A thinking block appended under a still-open assistant entry would
		// render above text that arrives afterwards.
		const state = play([chunk("before"), thought("mid"), chunk("after")]);
		expect(
			state.entries.map((entry: AcpEntry) => [entry.role, entry.text]),
		).toEqual([
			["assistant", "before"],
			["thinking", "mid"],
			["assistant", "after"],
		]);
	});
});

// =============================================================================
// D1 — interleaving
// =============================================================================

describe("D1 — interleaving", () => {
	it("a tool call closes the open text entry; the reply resumes in a NEW one", () => {
		const opened = appendUserPrompt(emptyTranscript(), "do it");
		const state = play(
			[
				chunk("I will read it."),
				update({
					kind: "tool_call",
					toolCall: {
						toolCallId: "t1",
						title: "Read File",
						status: "pending",
					},
				}),
				update({
					kind: "tool_call_update",
					toolCall: {
						toolCallId: "t1",
						status: "completed",
					},
				}),
				chunk("Done."),
			],
			opened,
		);

		expect(
			state.entries.map((entry: AcpEntry) => [entry.role, entry.text]),
		).toEqual([
			["user", "do it"],
			["assistant", "I will read it."],
			["tool", undefined],
			["assistant", "Done."],
		]);
	});

	it("does not reopen the earlier entry — the pre-card text is closed", () => {
		const opened = appendUserPrompt(emptyTranscript(), "do it");
		const state = play(
			[
				chunk("before"),
				update({
					kind: "tool_call",
					toolCall: { toolCallId: "t1", title: "Read File" },
				}),
				chunk("after"),
			],
			opened,
		);
		const first = state.entries[1];
		expect(first?.role === "assistant" && first.closed).toBeTrue();
		expect(state.entries[1]?.text).toBe("before");
	});

	it("keeps two cards in arrival order between text runs", () => {
		const call = (id: string, title: string) =>
			update({
				kind: "tool_call",
				toolCall: { toolCallId: id, title },
			});
		const state = play([
			chunk("a"),
			call("t1", "one"),
			call("t2", "two"),
			chunk("b"),
		]);
		expect(state.entries.map((entry) => entry.role)).toEqual([
			"assistant",
			"tool",
			"tool",
			"assistant",
		]);
		expect(toolEntries(state).map((e) => e.call.title)).toEqual(["one", "two"]);
	});
});

// =============================================================================
// D4 — plan
// =============================================================================

describe("D4 — plan", () => {
	const planFrame = (
		entries: {
			content: string;
			priority: "medium";
			status: "pending" | "in_progress" | "completed";
		}[],
	) => update({ kind: "plan", entries });

	it("is store-level, not an entry", () => {
		const state = play([
			planFrame([
				{ content: "step one", priority: "medium", status: "pending" },
			]),
		]);
		expect(state.entries).toHaveLength(0);
		expect(state.plan).toEqual([
			{ content: "step one", priority: "medium", status: "pending" },
		]);
	});

	it("REPLACES wholesale — every frame carries the complete list", () => {
		const state = play([
			planFrame([
				{ content: "one", priority: "medium", status: "pending" },
				{ content: "two", priority: "medium", status: "pending" },
			]),
			planFrame([
				{ content: "one", priority: "medium", status: "completed" },
				{ content: "two", priority: "medium", status: "in_progress" },
			]),
		]);
		expect(state.plan).toEqual([
			{ content: "one", priority: "medium", status: "completed" },
			{ content: "two", priority: "medium", status: "in_progress" },
		]);
	});

	it("is cleared on session_exit, while usage and lastCost survive", () => {
		// The plan belonged to the child that died; the usage meter's figures
		// are the last thing the user was told and must not blank themselves.
		const alive = play([
			planFrame([{ content: "one", priority: "medium", status: "pending" }]),
			update({
				kind: "usage_update",
				used: 100,
				size: 1000,
				cost: { amount: 0.5, currency: "USD" },
			}),
		]);
		const dead = play(
			[{ type: "session_exit", code: 0, signal: null, expected: true }],
			alive,
		);

		expect(dead.plan).toBeNull();
		expect(dead.usage).toEqual({
			used: 100,
			size: 1000,
			cost: { amount: 0.5, currency: "USD" },
		});
		expect(dead.lastCost).toEqual({ amount: 0.5, currency: "USD" });
	});

	it("survives turn_end — the plan outlives one turn", () => {
		const state = play([
			planFrame([{ content: "one", priority: "medium", status: "pending" }]),
			{ type: "turn_end", stopReason: "end_turn" },
		]);
		expect(state.plan).toHaveLength(1);
	});
});

// =============================================================================
// D3 — usage
// =============================================================================

describe("D3 — usage and cost", () => {
	it("takes the latest frame", () => {
		const state = play([
			update({ kind: "usage_update", used: 41371, size: 1000000, cost: null }),
			update({ kind: "usage_update", used: 43397, size: 1000000, cost: null }),
		]);
		expect(state.usage).toEqual({ used: 43397, size: 1000000, cost: null });
	});

	it("retains the last non-null cost across later null-cost frames", () => {
		// Ground truth 3: `cost` is null on every frame but the turn-final one,
		// so reading it off `usage` alone blanks the figure the moment the next
		// turn starts.
		const state = play([
			update({
				kind: "usage_update",
				used: 1,
				size: 10,
				cost: { amount: 0.67, currency: "USD" },
			}),
			update({ kind: "usage_update", used: 2, size: 10, cost: null }),
			update({ kind: "usage_update", used: 3, size: 10, cost: null }),
		]);
		expect(state.usage?.cost).toBeNull();
		expect(state.lastCost).toEqual({ amount: 0.67, currency: "USD" });
	});

	it("lets a NEW non-null cost supersede the old one", () => {
		const state = play([
			update({
				kind: "usage_update",
				used: 1,
				size: 10,
				cost: { amount: 0.67, currency: "USD" },
			}),
			update({
				kind: "usage_update",
				used: 2,
				size: 10,
				cost: { amount: 1.42, currency: "USD" },
			}),
		]);
		expect(state.lastCost).toEqual({ amount: 1.42, currency: "USD" });
	});

	it("is null before any frame arrives", () => {
		const state = emptyTranscript();
		expect(state.usage).toBeNull();
		expect(state.lastCost).toBeNull();
	});

	it("produces no entries", () => {
		const state = play([
			update({ kind: "usage_update", used: 1, size: 10, cost: null }),
		]);
		expect(state.entries).toHaveLength(0);
	});
});

// =============================================================================
// D1 — the ignored-kinds ledger
// =============================================================================

describe("D1 — kinds that left ignoredKinds", () => {
	const nowRendered: AcpPaneEvent[] = [
		thought("thinking"),
		update({
			kind: "tool_call",
			toolCall: { toolCallId: "t1", title: "Read File" },
		}),
		update({
			kind: "tool_call_update",
			toolCall: { toolCallId: "t1", status: "completed" },
		}),
		update({ kind: "plan", entries: [] }),
		update({ kind: "usage_update", used: 1, size: 10, cost: null }),
	];

	it("counts none of the five Phase 3 kinds as ignored", () => {
		const state = play(nowRendered);
		expect(state.ignoredKinds).toEqual({});
		for (const kind of [
			"agent_thought_chunk",
			"tool_call",
			"tool_call_update",
			"plan",
			"usage_update",
		]) {
			expect(state.ignoredKinds[kind]).toBeUndefined();
		}
	});

	it("still counts the session metadata kinds and unknown", () => {
		const state = play([
			update({ kind: "available_commands_update", commands: [] }),
			update({ kind: "config_option_update", options: [], seq: 1 }),
			update({ kind: "current_mode_update", modeId: "m" }),
			update({ kind: "session_info_update", title: null, updatedAt: null }),
			update({ kind: "unknown", raw: { anything: true } }),
			update({ kind: "unknown", raw: { again: true } }),
		]);
		expect(state.ignoredKinds).toEqual({
			available_commands_update: 1,
			config_option_update: 1,
			current_mode_update: 1,
			session_info_update: 1,
			unknown: 2,
		});
		expect(state.entries).toHaveLength(0);
	});
});

// =============================================================================
// Purity
// =============================================================================

describe("purity", () => {
	const events: AcpPaneEvent[] = [
		chunk("hello"),
		thought("hmm"),
		update({
			kind: "tool_call",
			toolCall: {
				toolCallId: "t1",
				title: "Read File",
				status: "pending",
				content: [],
			},
		}),
		update({
			kind: "tool_call_update",
			toolCall: {
				toolCallId: "t1",
				title: "Read alpha.txt",
				status: "completed",
			},
		}),
		update({ kind: "plan", entries: [] }),
		update({
			kind: "usage_update",
			used: 1,
			size: 10,
			cost: { amount: 0.1, currency: "USD" },
		}),
	];

	it("gives the same output for the same input, twice", () => {
		expect(JSON.stringify(play(events))).toBe(JSON.stringify(play(events)));
	});

	it("does not mutate the state it was handed", () => {
		const before = play(events);
		const snapshot = JSON.stringify(before);
		play(events, before);
		expect(JSON.stringify(before)).toBe(snapshot);
	});

	it("does not mutate the tool-call payload it was handed", () => {
		const toolCall = {
			sessionUpdate: "tool_call" as const,
			toolCallId: "t1",
			title: "Read File",
			content: [],
			locations: [],
		};
		const snapshot = JSON.stringify(toolCall);
		play([update({ kind: "tool_call", toolCall })]);
		expect(JSON.stringify(toolCall)).toBe(snapshot);
	});

	it("never throws, for the whole Phase 3 event surface", () => {
		for (const event of events) {
			expect(() => reduceAcpEvent(emptyTranscript(), event)).not.toThrow();
		}
	});

	it("gives every entry, of every role, a distinct id", () => {
		const state = play(events);
		const ids = state.entries.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
