/**
 * Phase 6 in the reducer: what a `session/load` replay renders as, and the
 * parts of the request-card lifecycle `transcript.requests.test.ts` does not
 * reach.
 *
 * `user_message_chunk` (A3) has no reducer coverage anywhere — it is the frame
 * that reconstructs the user's half of a restored conversation, and a replay
 * that renders only the agent's half looks like a working restore.
 */

import { describe, expect, it } from "bun:test";
import type { AcpPaneEvent } from "lib/trpc/routers/acp";
import {
	type AcpEntry,
	type AcpRequestEntry,
	type AcpTranscript,
	appendUserPrompt,
	emptyTranscript,
	reduceAcpEvent,
	settleRequest,
} from "./transcript";

function run(events: AcpPaneEvent[], from = emptyTranscript()): AcpTranscript {
	return events.reduce(reduceAcpEvent, from);
}

function userChunk(text: string): AcpPaneEvent {
	return { type: "update", update: { kind: "user_message_chunk", text } };
}

function agentChunk(text: string): AcpPaneEvent {
	return { type: "update", update: { kind: "agent_message_chunk", text } };
}

function shape(state: AcpTranscript): { role: string; text?: string }[] {
	return state.entries.map((entry: AcpEntry) => ({
		role: entry.role,
		...(typeof entry.text === "string" ? { text: entry.text } : {}),
	}));
}

const permission: AcpPaneEvent = {
	type: "permission_request",
	requestId: "req-1",
	title: "Write beta.txt",
	options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
};

function requestEntry(
	state: AcpTranscript,
	requestId: string,
): AcpRequestEntry {
	const index = state.requestIdToEntry[requestId];
	const entry = index === undefined ? undefined : state.entries[index];
	if (entry?.role !== "request") {
		throw new Error(`no request entry for ${requestId}`);
	}
	return entry;
}

// =============================================================================
// A3 — the user's half of a replayed conversation
// =============================================================================

describe("user_message_chunk (A3)", () => {
	it("renders as a user entry rather than falling into `unknown`", () => {
		const state = run([userChunk("edit beta.txt for me")]);

		expect(shape(state)).toEqual([
			{ role: "user", text: "edit beta.txt for me" },
		]);
		// The failure this exists to catch is silent: an unmapped kind is
		// COUNTED, not dropped, so the transcript renders empty and nothing
		// throws.
		expect(state.ignoredKinds).toEqual({});
	});

	it("appends consecutive chunks into ONE message", () => {
		const state = run([userChunk("edit "), userChunk("beta.txt")]);

		expect(shape(state)).toEqual([{ role: "user", text: "edit beta.txt" }]);
	});

	it("starts a NEW user entry after the agent has spoken in between", () => {
		// Two turns of a replayed conversation. Appending across the agent's
		// reply would merge two separate questions into one bubble.
		const state = run([
			userChunk("first question"),
			agentChunk("first answer"),
			userChunk("second question"),
		]);

		expect(shape(state)).toEqual([
			{ role: "user", text: "first question" },
			{ role: "assistant", text: "first answer" },
			{ role: "user", text: "second question" },
		]);
	});

	it("closes the user entry at a turn boundary", () => {
		const ended = run([
			userChunk("hello"),
			{ type: "turn_end", stopReason: "end_turn" },
		]);
		expect(ended.openUserIndex).toBe(null);

		// So the next turn's user text opens its own bubble instead of growing
		// the previous turn's.
		const state = reduceAcpEvent(ended, userChunk("again"));
		expect(shape(state).filter((entry) => entry.role === "user")).toEqual([
			{ role: "user", text: "hello" },
			{ role: "user", text: "again" },
		]);
	});

	it("does not append a replayed chunk onto a locally-typed prompt", () => {
		// `appendUserPrompt` is what the composer calls. A replay landing after
		// it must open its own entry, or a restore would graft history onto the
		// message the user just sent.
		const typed = appendUserPrompt(emptyTranscript(), "typed by hand");
		const state = run([userChunk("replayed")], typed);

		expect(shape(state)).toEqual([
			{ role: "user", text: "typed by hand" },
			{ role: "assistant", text: "" },
			{ role: "user", text: "replayed" },
		]);
	});

	it("reconstructs a whole replayed conversation, both sides, in order", () => {
		// The fixture `FakeAcpChild.fixtureReplayHistory()` replays, reduced end
		// to end: this is what gate 1's "the replayed transcript" actually looks
		// like on screen.
		const state = run([
			userChunk("edit beta.txt for me"),
			agentChunk("Editing it now."),
			{
				type: "update",
				update: {
					kind: "tool_call",
					toolCall: {
						toolCallId: "toolu_fixture_edit",
						title: "Edit",
						kind: "edit",
						status: "pending",
					},
				},
			},
			{
				type: "update",
				update: {
					kind: "tool_call_update",
					toolCall: {
						toolCallId: "toolu_fixture_edit",
						title: "Edit beta.txt",
						status: "completed",
					},
				},
			},
			agentChunk("Done."),
		]);

		expect(state.entries.map((entry) => entry.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
		// One card, merged by id — not two, which is what an append-instead-of-
		// merge produces and what makes a completed tool render twice.
		const tool = state.entries.find((entry) => entry.role === "tool");
		expect(tool).toMatchObject({
			toolCallId: "toolu_fixture_edit",
			call: { title: "Edit beta.txt", status: "completed" },
		});
	});
});

// =============================================================================
// B2 — request cards, the parts the builder's suite leaves open
// =============================================================================

describe("request cards", () => {
	it("appears BELOW text that was still streaming when it arrived", () => {
		// A card that rendered above the sentence that prompted it would read as
		// the agent asking before it explained why.
		const state = run([agentChunk("I need to write a file. "), permission]);

		expect(state.entries.map((entry) => entry.role)).toEqual([
			"assistant",
			"request",
		]);
		// And the assistant entry is closed, so a later chunk opens a new one
		// rather than growing text that now sits above a card.
		expect(state.openIndex).toBe(null);
	});

	it("a later chunk lands after the card, not back inside the earlier text", () => {
		const state = run([
			agentChunk("thinking about it. "),
			permission,
			agentChunk("thanks!"),
		]);

		expect(shape(state)).toEqual([
			{ role: "assistant", text: "thinking about it. " },
			{ role: "request" },
			{ role: "assistant", text: "thanks!" },
		]);
	});

	it("settleRequest is a no-op for an id the transcript never saw", () => {
		const state = run([permission]);

		expect(
			settleRequest(state, "req-never", { kind: "answered", summary: "Allow" }),
		).toBe(state);
	});

	it("settleRequest leaves OTHER cards alone", () => {
		const second: AcpPaneEvent = {
			type: "elicitation_request",
			requestId: "req-2",
			message: "Which approach?",
			form: { fields: [] },
		};
		const state = run([permission, second]);

		const settled = settleRequest(state, "req-1", {
			kind: "answered",
			summary: "Allow",
		});

		expect(requestEntry(settled, "req-1").outcome).toEqual({
			kind: "answered",
			summary: "Allow",
		});
		expect(requestEntry(settled, "req-2").outcome).toBe(null);
	});

	it("a declined card is settled and stays settled", () => {
		const state = settleRequest(run([permission]), "req-1", {
			kind: "declined",
		});

		expect(requestEntry(state, "req-1").outcome).toEqual({ kind: "declined" });
		const again = settleRequest(state, "req-1", {
			kind: "answered",
			summary: "Allow",
		});
		expect(requestEntry(again, "req-1").outcome).toEqual({ kind: "declined" });
	});
});

describe("session_exit sweep", () => {
	const exit: AcpPaneEvent = {
		type: "session_exit",
		code: 1,
		signal: null,
		expected: false,
	};

	it("marks a PENDING card unavailable", () => {
		const before = run([permission]);
		const after = reduceAcpEvent(before, exit);

		const card = after.entries.find(
			(entry): entry is AcpRequestEntry => entry.role === "request",
		);
		expect(card?.outcome).toEqual({
			kind: "unavailable",
			reason: "Session ended before this was answered.",
		});
	});

	it("does NOT rewrite a card the user really answered", () => {
		// The mutation this guards against rewrites history: a card the user
		// answered would come back reading "session ended before this was
		// answered", which is a false statement about what happened.
		const answered = settleRequest(run([permission]), "req-1", {
			kind: "answered",
			summary: "Allow",
		});
		const after = reduceAcpEvent(answered, exit);

		const card = after.entries.find(
			(entry): entry is AcpRequestEntry => entry.role === "request",
		);
		expect(card?.outcome).toEqual({ kind: "answered", summary: "Allow" });
	});

	it("sweeps every pending card, not just the first", () => {
		const state = run([
			permission,
			{
				type: "permission_request",
				requestId: "req-2",
				title: "Write gamma.txt",
				options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
			},
			{
				type: "elicitation_request",
				requestId: "req-3",
				message: "Which?",
				form: { fields: [] },
			},
		]);

		const after = reduceAcpEvent(state, exit);

		const outcomes = after.entries
			.filter((entry): entry is AcpRequestEntry => entry.role === "request")
			.map((entry) => entry.outcome?.kind);
		expect(outcomes).toEqual(["unavailable", "unavailable", "unavailable"]);
	});

	it("empties requestIdToEntry so the next session's ids cannot reopen a card", () => {
		const after = reduceAcpEvent(run([permission]), exit);

		expect(after.requestIdToEntry).toEqual({});

		// PROVES IT MATTERS: `AcpSession` mints ids from its own counter, so the
		// next generation reuses `req-1`. With a surviving index that would merge
		// into the card above the divider and revert it to pending.
		const next = reduceAcpEvent(after, permission);
		const cards = next.entries.filter(
			(entry): entry is AcpRequestEntry => entry.role === "request",
		);
		expect(cards).toHaveLength(2);
		expect(cards[0]?.outcome?.kind).toBe("unavailable");
		expect(cards[1]?.outcome).toBe(null);
	});

	it("leaves a transcript with no cards untouched", () => {
		const before = run([agentChunk("hello")]);
		const after = reduceAcpEvent(before, exit);

		// Only the divider is added; nothing invents a card to sweep.
		expect(after.entries.map((entry) => entry.role)).toEqual([
			"assistant",
			"divider",
		]);
	});
});

describe("session_error", () => {
	const sessionError: AcpPaneEvent = {
		type: "session_error",
		message: "acp-session-died: exited",
	};

	it("sweeps pending cards too — the session is just as gone", () => {
		const after = reduceAcpEvent(run([permission]), sessionError);

		const card = after.entries.find(
			(entry): entry is AcpRequestEntry => entry.role === "request",
		);
		expect(card?.outcome?.kind).toBe("unavailable");
	});

	it("empties requestIdToEntry like session_exit does (A11/F5)", () => {
		// The two events describe the same fact — this child is not coming back
		// — so an index that survives one and not the other is an asymmetry, not
		// a decision. `session_error` is the path a crash takes.
		const after = reduceAcpEvent(run([permission]), sessionError);

		expect(after.requestIdToEntry).toEqual({});
	});

	it("PROVES IT MATTERS: the next session's req-1 opens its own card", () => {
		const after = reduceAcpEvent(run([permission]), sessionError);

		const next = reduceAcpEvent(after, permission);

		const cards = next.entries.filter(
			(entry): entry is AcpRequestEntry => entry.role === "request",
		);
		expect(cards).toHaveLength(2);
		// The swept card stays swept; the new one opens below the divider.
		expect(cards[0]?.outcome?.kind).toBe("unavailable");
		expect(cards[1]?.outcome).toBe(null);
	});
});
