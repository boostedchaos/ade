/**
 * D5's status mapping, as a pure function.
 *
 * The mapping matters because an ACP pane is the SOLE writer of its own
 * status: nothing else will correct it if this is wrong, and a pane stuck on
 * "working" rings Mission Control forever.
 */

import { describe, expect, it } from "bun:test";
import type { AcpPaneEvent } from "lib/trpc/routers/acp";
import { ACP_STATUS_ON_PROMPT, acpStatusForEvent } from "./useAcpPaneStatus";

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

	it("turn_error → idle", () => {
		expect(acpStatusForEvent({ type: "turn_error", message: "x" })).toBe(
			"idle",
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

	it("never returns permission under Phase 2's auto-approve policy", () => {
		const events: AcpPaneEvent[] = [
			{ type: "turn_end", stopReason: "end_turn" },
			{ type: "turn_error", message: "x" },
			{ type: "session_error", message: "x" },
			{ type: "session_exit", code: 0, signal: null, expected: true },
			{ type: "update", update: { kind: "unknown", raw: null } },
		];
		for (const event of events) {
			expect(acpStatusForEvent(event)).not.toBe("permission");
		}
	});
});
