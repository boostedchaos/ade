/**
 * The transcript reducer — the whole of Phase 2's rendering logic, as a pure
 * function, testable without Electron, IPC, an adapter, or a login.
 */

import { describe, expect, it } from "bun:test";
import type { AcpPaneEvent } from "lib/trpc/routers/acp";
import {
	appendUserPrompt,
	emptyTranscript,
	reduceAcpEvent,
} from "./transcript";

function chunk(text: string): AcpPaneEvent {
	return { type: "update", update: { kind: "agent_message_chunk", text } };
}

/** Fold a sequence, the way the pane's subscription does. */
function play(events: AcpPaneEvent[], from = emptyTranscript()) {
	return events.reduce(reduceAcpEvent, from);
}

describe("chunk accumulation", () => {
	it("appends chunks into the open assistant message", () => {
		const opened = appendUserPrompt(emptyTranscript(), "say OK");
		const state = play([chunk("O"), chunk("K")], opened);

		expect(state.entries.map((e) => [e.role, e.text])).toEqual([
			["user", "say OK"],
			["assistant", "OK"],
		]);
	});

	it("opens a message for a stray chunk rather than dropping it", () => {
		// Unsolicited output must be DISPLAYED: a pane that silently discards
		// agent text is indistinguishable from a broken subscription.
		const state = play([chunk("unsolicited")]);

		expect(state.entries).toHaveLength(1);
		expect(state.entries[0]).toMatchObject({
			role: "assistant",
			text: "unsolicited",
			closed: false,
		});
	});

	it("opens exactly ONE message for a run of stray chunks", () => {
		const state = play([chunk("a"), chunk("b"), chunk("c")]);
		expect(state.entries).toHaveLength(1);
		expect(state.entries[0]?.text).toBe("abc");
	});

	it("gives every entry a distinct id", () => {
		const state = play([
			chunk("hi"),
			{ type: "turn_end", stopReason: "x" },
			chunk("again"),
		]);
		const ids = state.entries.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("turn boundaries", () => {
	it("turn_end closes the open message and records the stopReason", () => {
		const opened = appendUserPrompt(emptyTranscript(), "hi");
		const state = play(
			[chunk("done"), { type: "turn_end", stopReason: "end_turn" }],
			opened,
		);

		expect(state.openIndex).toBeNull();
		expect(state.entries.at(-1)).toMatchObject({
			closed: true,
			stopReason: "end_turn",
		});
	});

	it("a chunk after turn_end opens a NEW message", () => {
		const opened = appendUserPrompt(emptyTranscript(), "hi");
		const state = play(
			[
				chunk("first"),
				{ type: "turn_end", stopReason: "end_turn" },
				chunk("second"),
			],
			opened,
		);

		expect(state.entries.map((e) => e.text)).toEqual(["hi", "first", "second"]);
	});

	it("turn_end with no open message is harmless", () => {
		const state = play([{ type: "turn_end", stopReason: "end_turn" }]);
		expect(state.entries).toHaveLength(0);
		expect(state.openIndex).toBeNull();
	});

	it("turn_error closes the message and appends the message verbatim", () => {
		const opened = appendUserPrompt(emptyTranscript(), "hi");
		const state = play(
			[
				chunk("partial"),
				{ type: "turn_error", message: "acp-session-died: child exited" },
			],
			opened,
		);

		expect(state.openIndex).toBeNull();
		expect(state.entries.at(-1)).toMatchObject({
			role: "divider",
			text: "acp-session-died: child exited",
		});
		// The partial output is KEPT — it is what the agent actually said.
		expect(state.entries[1]?.text).toBe("partial");
	});
});

describe("session end", () => {
	it("an unexpected exit appends a divider naming the exit code", () => {
		const state = play([
			chunk("working"),
			{ type: "session_exit", code: 3, signal: null, expected: false },
		]);

		expect(state.openIndex).toBeNull();
		expect(state.entries.at(-1)?.role).toBe("divider");
		expect(state.entries.at(-1)?.text).toContain("3");
	});

	it("names the signal when there is one", () => {
		const state = play([
			{ type: "session_exit", code: null, signal: "SIGKILL", expected: false },
		]);
		expect(state.entries.at(-1)?.text).toContain("SIGKILL");
	});

	it("an EXPECTED exit does not shout about an exit code", () => {
		const state = play([
			{ type: "session_exit", code: 0, signal: null, expected: true },
		]);
		expect(state.entries.at(-1)?.text).toBe("Session closed.");
	});

	it("session_error appends the coded message verbatim", () => {
		const state = play([
			{ type: "session_error", message: "acp-rpc-error: bad frame" },
		]);
		expect(state.entries.at(-1)?.text).toBe("acp-rpc-error: bad frame");
	});

	it("keeps the old transcript above the divider for a new session", () => {
		// D6: the "New session" button creates a fresh child; the transcript is
		// not cleared, and the divider is what separates the generations.
		const dead = play([
			chunk("first session"),
			{ type: "session_exit", code: 1, signal: null, expected: false },
		]);
		const revived = play([chunk("second session")], dead);

		expect(revived.entries.map((e) => e.role)).toEqual([
			"assistant",
			"divider",
			"assistant",
		]);
		expect(revived.entries[0]?.text).toBe("first session");
	});
});

describe("kinds Phase 2 does not render", () => {
	const ignored: AcpPaneEvent[] = [
		{ type: "update", update: { kind: "agent_thought_chunk", text: "hmm" } },
		{ type: "update", update: { kind: "plan", entries: [] } },
		{
			type: "update",
			update: { kind: "available_commands_update", commands: [] },
		},
		{ type: "update", update: { kind: "config_option_update", options: [] } },
		{ type: "update", update: { kind: "current_mode_update", modeId: "m" } },
		{
			type: "update",
			update: { kind: "session_info_update", title: null, updatedAt: null },
		},
		{
			type: "update",
			update: { kind: "usage_update", used: 1, size: 2, cost: null },
		},
		{ type: "update", update: { kind: "unknown", raw: { anything: true } } },
	];

	it("counts them and renders none of them", () => {
		const state = play(ignored);
		expect(state.entries).toHaveLength(0);
		expect(state.ignoredKinds.agent_thought_chunk).toBe(1);
		expect(state.ignoredKinds.usage_update).toBe(1);
		// `unknown` is what a FUTURE adapter version's new kind arrives as. It
		// must be counted, not thrown on — a version bump cannot break the pane.
		expect(state.ignoredKinds.unknown).toBe(1);
	});

	it("never throws, for any of them", () => {
		for (const event of ignored) {
			expect(() => reduceAcpEvent(emptyTranscript(), event)).not.toThrow();
		}
	});

	it("does not disturb an open message", () => {
		const opened = appendUserPrompt(emptyTranscript(), "hi");
		const state = play(
			[
				chunk("real"),
				{ type: "update", update: { kind: "agent_thought_chunk", text: "x" } },
				chunk(" text"),
			],
			opened,
		);
		expect(state.entries.at(-1)?.text).toBe("real text");
	});
});

describe("purity", () => {
	it("does not mutate the input state", () => {
		const before = appendUserPrompt(emptyTranscript(), "hi");
		const snapshot = JSON.stringify(before);
		reduceAcpEvent(before, chunk("mutate me"));
		expect(JSON.stringify(before)).toBe(snapshot);
	});
});
