/**
 * Phase 3: a whole tool-call lifecycle crossing the real wire.
 *
 * The reducer suite in the desktop app replays the captured frames as plain
 * objects, which proves the merge rules but assumes the frames reach the
 * renderer unchanged. This file closes that assumption at the other end: the
 * fixture is written to a real `stdout` as JSON-RPC, parsed by the real SDK,
 * mapped by the real `mapSessionUpdate`, and read off the host's per-pane
 * `update:${paneId}` event — the same path a live adapter's frames take.
 *
 * What it defends is the field-level fidelity the renderer depends on: the
 * refined title, the `locations` array, BOTH diff payloads in order (the
 * duplicate-diff regression is only visible if the second one actually
 * arrives), the terminal `status`, and `_meta.claudeCode.toolName` — which is
 * where the programmatic tool name lives, `ToolCall.name` never being set.
 */

import { describe, expect, it } from "bun:test";
import { AcpHost } from "./acp-host";
import { setAcpBinaryPathResolver } from "./binary-resolver";
import { FakeAcpChild, fixtureToolCallSequence } from "./fake-acp-child";
import type { AcpSessionUpdate } from "./types";

setAcpBinaryPathResolver(() => "/fake/claude-agent-acp/index.js");

/** Spin until `count` updates have been delivered, or fail loudly. */
async function waitForUpdates(
	updates: AcpSessionUpdate[],
	count: number,
): Promise<void> {
	const deadline = Date.now() + 1000;
	while (updates.length < count) {
		if (Date.now() > deadline) {
			throw new Error(
				`only ${updates.length} of ${count} updates within 1000ms`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("tool-call lifecycle over the wire", () => {
	it("delivers the whole fixture sequence intact through mapSessionUpdate", async () => {
		const host = new AcpHost();
		const child = new FakeAcpChild();
		const updates: AcpSessionUpdate[] = [];

		await host.createSession({
			paneId: "pane-tools",
			cwd: process.cwd(),
			spawnProcess: child.spawnProcess,
		});
		host.on("update:pane-tools", (update: AcpSessionUpdate) =>
			updates.push(update),
		);

		const sequence = fixtureToolCallSequence();
		for (const frame of sequence) child.sessionUpdate(frame);
		await waitForUpdates(updates, sequence.length);

		// Kind discrimination: one opening call, four updates, in order.
		expect(updates.map((update) => update.kind)).toEqual([
			"tool_call",
			"tool_call_update",
			"tool_call_update",
			"tool_call_update",
			"tool_call_update",
		]);

		// And the payloads verbatim — `mapSessionUpdate` carries the adapter's
		// own object across, so each mapped frame must equal what was sent.
		// The two sides are the same objects by value but different declared
		// types (`ToolCall` / `ToolCallUpdate` vs the `SessionUpdate` member the
		// fixture is written as), so the comparison is made at `unknown`.
		expect(
			updates.map((update) =>
				update.kind === "tool_call" || update.kind === "tool_call_update"
					? update.toolCall
					: null,
			) as unknown[],
		).toEqual(sequence as unknown[]);

		await host.disposeAll();
	});

	it("keeps the fields the renderer reads: title, locations, both diffs, status, toolName", async () => {
		const host = new AcpHost();
		const child = new FakeAcpChild();
		const updates: AcpSessionUpdate[] = [];

		await host.createSession({
			paneId: "pane-tool-fields",
			cwd: process.cwd(),
			spawnProcess: child.spawnProcess,
		});
		host.on("update:pane-tool-fields", (update: AcpSessionUpdate) =>
			updates.push(update),
		);

		const sequence = fixtureToolCallSequence("toolu_wire_1", "/repo/beta.txt");
		for (const frame of sequence) child.sessionUpdate(frame);
		await waitForUpdates(updates, sequence.length);

		const calls = updates.flatMap((update) =>
			update.kind === "tool_call" || update.kind === "tool_call_update"
				? [update.toolCall]
				: [],
		);

		// Every frame is for the one call: correlation is `toolCallId` only.
		expect(new Set(calls.map((call) => call.toolCallId))).toEqual(
			new Set(["toolu_wire_1"]),
		);

		expect(calls[0]?.status).toBe("pending");
		expect(calls[0]?.title).toBe("Edit");
		expect(calls[1]?.title).toBe("Edit beta.txt");
		expect(calls[1]?.locations).toEqual([{ path: "/repo/beta.txt" }]);

		// TWO diff-bearing frames reach the renderer. If the wire collapsed them
		// the duplicate-diff regression would be untestable downstream.
		const diffs = calls.flatMap(
			(call) => call.content?.filter((item) => item.type === "diff") ?? [],
		);
		expect(diffs).toHaveLength(2);
		expect(diffs[0]).toMatchObject({ newText: "beta line 2 EDITED" });
		expect(diffs[1]).toMatchObject({
			newText: "beta line 1\nbeta line 2 EDITED",
		});

		const last = calls.at(-1);
		expect(last?.status).toBe("completed");
		// The terminal frame is sparse: it carries status and nothing else the
		// card shows, which is what makes the reducer's merge load-bearing.
		expect(last?.title).toBeUndefined();
		expect(last?.content).toBeUndefined();

		// `name` is never set on this wire; the real name is in `_meta`.
		expect(calls.every((call) => call.name === undefined)).toBeTrue();
		expect(
			(
				calls[0]?._meta as
					| { claudeCode?: { toolName?: string } }
					| null
					| undefined
			)?.claudeCode?.toolName,
		).toBe("Edit");

		await host.disposeAll();
	});
});
