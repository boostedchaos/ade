import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decideStateFromTranscriptTail,
	inspectTranscript,
	readTranscriptTail,
} from "./transcript-corrector";

/** Synthetic transcript entries in Claude Code's JSONL shape. */
const assistantText = (text: string) =>
	JSON.stringify({
		type: "assistant",
		message: { role: "assistant", content: [{ type: "text", text }] },
	});

const assistantToolUse = (name: string) =>
	JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me check." },
				{ type: "tool_use", name, input: {} },
			],
		},
	});

const toolResult = () =>
	JSON.stringify({
		type: "user",
		message: {
			role: "user",
			content: [{ type: "tool_result", content: "ok" }],
		},
	});

const userMessage = (text: string) =>
	JSON.stringify({
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
	});

describe("decideStateFromTranscriptTail", () => {
	it("calls a finished assistant answer idle", () => {
		expect(
			decideStateFromTranscriptTail([
				userMessage("what is 2+2"),
				assistantText("4"),
			]),
		).toBe("idle");
	});

	it("calls an outstanding tool call still working", () => {
		expect(
			decideStateFromTranscriptTail([
				userMessage("build it"),
				assistantToolUse("Bash"),
			]),
		).toBe("working");
	});

	it("calls a tool result still working — the agent has the turn back", () => {
		expect(
			decideStateFromTranscriptTail([assistantToolUse("Bash"), toolResult()]),
		).toBe("working");
	});

	it("calls an unanswered user message working", () => {
		expect(
			decideStateFromTranscriptTail([
				assistantText("done"),
				userMessage("now this"),
			]),
		).toBe("working");
	});

	it("recognises an explicit permission request as needsInput", () => {
		expect(
			decideStateFromTranscriptTail([
				assistantText("I need approval"),
				JSON.stringify({ type: "permission_request", tool: "Bash" }),
			]),
		).toBe("needsInput");
	});

	it("defaults to working on an empty tail — no evidence is not evidence", () => {
		expect(decideStateFromTranscriptTail([])).toBe("working");
		expect(decideStateFromTranscriptTail(["", "   "])).toBe("working");
	});

	it("defaults to working when nothing parses", () => {
		expect(decideStateFromTranscriptTail(["not json", "{broken"])).toBe(
			"working",
		);
	});

	it("skips a truncated leading line and reads the rest", () => {
		// A tail read starts mid-file, so the first line is routinely partial.
		expect(
			decideStateFromTranscriptTail([
				'ssage":{"role":"user","content":[{"type":"text"',
				assistantText("all done"),
			]),
		).toBe("idle");
	});

	it("ignores meta entries", () => {
		expect(
			decideStateFromTranscriptTail([
				assistantText("done"),
				JSON.stringify({
					type: "user",
					isMeta: true,
					message: { role: "user" },
				}),
			]),
		).toBe("idle");
	});

	it("reads the LAST meaningful entry, not the first", () => {
		expect(
			decideStateFromTranscriptTail([
				assistantToolUse("Bash"),
				toolResult(),
				assistantText("finished"),
			]),
		).toBe("idle");
	});
});

describe("readTranscriptTail", () => {
	it("returns the tail of a real file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ade-transcript-"));
		try {
			const file = join(dir, "t.jsonl");
			writeFileSync(file, `${userMessage("hi")}\n${assistantText("done")}\n`);
			const lines = await readTranscriptTail(file);
			expect(lines.length).toBeGreaterThan(0);
			expect(await inspectTranscript(file)).toBe("idle");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads only the last N bytes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ade-transcript-"));
		try {
			const file = join(dir, "t.jsonl");
			const filler = `${assistantToolUse("Bash")}\n`.repeat(50);
			writeFileSync(file, `${filler}${assistantText("done")}\n`);
			const lines = await readTranscriptTail(file, 200);
			expect(lines.join("\n").length).toBeLessThanOrEqual(200);
			// The final entry is inside the window, so the verdict is still idle.
			expect(decideStateFromTranscriptTail(lines)).toBe("idle");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns no lines for a missing file rather than throwing", async () => {
		expect(await readTranscriptTail("/nope/does-not-exist.jsonl")).toEqual([]);
		expect(await inspectTranscript("/nope/does-not-exist.jsonl")).toBe(
			"working",
		);
	});

	it("returns no lines for an empty file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ade-transcript-"));
		try {
			const file = join(dir, "empty.jsonl");
			writeFileSync(file, "");
			expect(await readTranscriptTail(file)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
