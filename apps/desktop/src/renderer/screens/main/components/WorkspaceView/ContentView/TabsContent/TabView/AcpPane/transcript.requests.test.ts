/**
 * Smoke coverage for the request cards in the reducer (B2). An independent
 * author follows.
 */

import { describe, expect, it } from "bun:test";
import type { AcpPaneEvent } from "lib/trpc/routers/acp";
import {
	type AcpRequestEntry,
	emptyTranscript,
	reduceAcpEvent,
	settleRequest,
} from "./transcript";

const permission: AcpPaneEvent = {
	type: "permission_request",
	requestId: "req-1",
	title: "Write beta.txt",
	toolName: "Write",
	options: [
		{ optionId: "allow", name: "Allow", kind: "allow_once" },
		{ optionId: "deny", name: "Deny", kind: "reject_once" },
	],
};

const elicitation: AcpPaneEvent = {
	type: "elicitation_request",
	requestId: "req-2",
	message: "Which approach?",
	form: {
		fields: [
			{
				key: "question_0",
				kind: "select",
				required: true,
				options: [{ value: "a", label: "Rewrite it" }],
			},
		],
	},
};

function requestEntries(state: {
	entries: { role: string }[];
}): AcpRequestEntry[] {
	return state.entries.filter(
		(entry): entry is AcpRequestEntry => entry.role === "request",
	);
}

describe("request entries", () => {
	it("a permission request becomes a pending card", () => {
		const state = reduceAcpEvent(emptyTranscript(), permission);
		const [card] = requestEntries(state);
		expect(card?.request).toMatchObject({
			requestId: "req-1",
			kind: "permission",
			title: "Write beta.txt",
			toolName: "Write",
		});
		expect(card?.outcome).toBe(null);
	});

	it("an elicitation request carries its form", () => {
		const state = reduceAcpEvent(emptyTranscript(), elicitation);
		const [card] = requestEntries(state);
		expect(card?.request.kind).toBe("elicitation");
		expect(card?.request.form?.fields).toHaveLength(1);
	});

	it("a re-delivered request does not produce a second card", () => {
		// A buffer drain racing a live emit; ids are minted per session, so a
		// duplicate is never a second question.
		const once = reduceAcpEvent(emptyTranscript(), permission);
		const twice = reduceAcpEvent(once, permission);
		expect(requestEntries(twice)).toHaveLength(1);
	});

	it("settling records the answer, and the FIRST answer wins", () => {
		const pending = reduceAcpEvent(emptyTranscript(), permission);
		const answered = settleRequest(pending, "req-1", {
			kind: "answered",
			summary: "Allow",
		});
		const again = settleRequest(answered, "req-1", {
			kind: "answered",
			summary: "Deny",
		});
		expect(requestEntries(again)[0]?.outcome).toEqual({
			kind: "answered",
			summary: "Allow",
		});
	});

	it("an `unavailable` outcome OVERRIDES an optimistic answer", () => {
		// The pane answers optimistically so the buttons disable on the click;
		// only the wire knows the answer did not land.
		const answered = settleRequest(
			reduceAcpEvent(emptyTranscript(), permission),
			"req-1",
			{ kind: "answered", summary: "Allow" },
		);
		const corrected = settleRequest(answered, "req-1", {
			kind: "unavailable",
			reason: "acp-request-not-found",
		});
		expect(requestEntries(corrected)[0]?.outcome).toEqual({
			kind: "unavailable",
			reason: "acp-request-not-found",
		});
	});

	it("a dead session settles PENDING cards and leaves answered ones alone", () => {
		const both = reduceAcpEvent(
			reduceAcpEvent(emptyTranscript(), permission),
			elicitation,
		);
		const answered = settleRequest(both, "req-1", {
			kind: "answered",
			summary: "Allow",
		});
		const dead = reduceAcpEvent(answered, {
			type: "session_exit",
			code: 1,
			signal: null,
			expected: false,
		});
		const [first, second] = requestEntries(dead);
		expect(first?.outcome).toEqual({ kind: "answered", summary: "Allow" });
		expect(second?.outcome?.kind).toBe("unavailable");
	});

	it("a dead session drops the request index, so a reused id opens a new card", () => {
		const dead = reduceAcpEvent(reduceAcpEvent(emptyTranscript(), permission), {
			type: "session_exit",
			code: 0,
			signal: null,
			expected: true,
		});
		const next = reduceAcpEvent(dead, permission);
		expect(requestEntries(next)).toHaveLength(2);
	});
});

describe("events_dropped", () => {
	it("renders as a divider naming the count", () => {
		const state = reduceAcpEvent(emptyTranscript(), {
			type: "events_dropped",
			count: 12,
		});
		expect(state.entries[0]).toMatchObject({
			role: "divider",
			text: "12 events dropped",
		});
	});

	it("says 'event' for exactly one", () => {
		const state = reduceAcpEvent(emptyTranscript(), {
			type: "events_dropped",
			count: 1,
		});
		expect(state.entries[0]?.text).toBe("1 event dropped");
	});
});
