/**
 * D5's status mapping, as a pure function.
 *
 * The mapping matters because an ACP pane is the SOLE writer of its own
 * status: nothing else will correct it if this is wrong, and a pane stuck on
 * "working" rings Mission Control forever.
 */

import { describe, expect, it } from "bun:test";
import type { AcpPaneEvent } from "lib/trpc/routers/acp";
import {
	ACP_STATUS_ON_ANSWER,
	ACP_STATUS_ON_PROMPT,
	acpStatusForEvent,
} from "./useAcpPaneStatus";

describe("acpStatusForEvent", () => {
	it("sends → working", () => {
		expect(ACP_STATUS_ON_PROMPT).toBe("working");
	});

	it("turn_end → review", () => {
		// "review", not "idle": the existing `acknowledgedStatus` machinery
		// downgrades it as soon as the user looks at the pane, which is what
		// makes a finished turn visible in a background tab.
		expect(
			acpStatusForEvent({ type: "turn_end", stopReason: "end_turn" }),
		).toBe("review");
	});

	it("turn_error → review (A6)", () => {
		// Was "idle" through Phase 5, which made a FAILED turn look like a
		// finished one: the pane went quiet and Mission Control never rang.
		expect(acpStatusForEvent({ type: "turn_error", message: "x" })).toBe(
			"review",
		);
	});

	it("session_exit → idle", () => {
		expect(
			acpStatusForEvent({
				type: "session_exit",
				code: 1,
				signal: null,
				expected: false,
			}),
		).toBe("idle");
	});

	it("session_error → idle", () => {
		expect(acpStatusForEvent({ type: "session_error", message: "x" })).toBe(
			"idle",
		);
	});

	it("a streamed chunk writes NOTHING", () => {
		// One store write per token would be the cost; "working" already covers
		// the whole turn.
		const event: AcpPaneEvent = {
			type: "update",
			update: { kind: "agent_message_chunk", text: "hi" },
		};
		expect(acpStatusForEvent(event)).toBeNull();
	});

	it("never returns permission for an event the auto-approve policy can emit", () => {
		// Under the default policy the host emits no permission or elicitation
		// request at all, so every event a pane can actually see is in this list.
		const events: AcpPaneEvent[] = [
			{ type: "turn_end", stopReason: "end_turn" },
			{ type: "turn_error", message: "x" },
			{ type: "session_error", message: "x" },
			{ type: "session_exit", code: 0, signal: null, expected: true },
			{ type: "update", update: { kind: "unknown", raw: null } },
			{ type: "events_dropped", count: 3 },
		];
		for (const event of events) {
			expect(acpStatusForEvent(event)).not.toBe("permission");
		}
	});

	it("a blocked request → permission, and answering → working (A6)", () => {
		expect(
			acpStatusForEvent({
				type: "permission_request",
				requestId: "perm-1",
				title: "Write beta.txt",
				options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
			}),
		).toBe("permission");
		expect(
			acpStatusForEvent({
				type: "elicitation_request",
				requestId: "elicit-1",
				message: "Which one?",
				form: {
					fields: [
						{
							key: "question_0",
							kind: "select",
							required: false,
							options: [{ value: "a", label: "A" }],
						},
					],
				},
			}),
		).toBe("permission");
		expect(ACP_STATUS_ON_ANSWER).toBe("working");
	});

	it("a dropped-events notice writes NOTHING", () => {
		expect(acpStatusForEvent({ type: "events_dropped", count: 12 })).toBeNull();
	});
});
