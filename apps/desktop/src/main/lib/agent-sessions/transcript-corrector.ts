/**
 * Stuck-state corrector.
 *
 * A hook can be lost — the agent is killed between PreToolUse and PostToolUse,
 * the notify curl times out, the machine sleeps mid-turn — and the pane is then
 * stuck showing `working` forever. After STALE_AFTER_MS with no event, this
 * reads the tail of Claude Code's conversation JSONL and decides what the
 * session is really doing.
 *
 * Two hard limits, both from the spec:
 *  - it may only move a session OUT of `working` (enforced in
 *    AgentSessionRegistry.correctStuck, not here) — the transcript corrects a
 *    stuck state, it never invents one;
 *  - the read is async and bounded, never on the main thread's critical path.
 */
import { open } from "node:fs/promises";

/** No hook for this long while `working` → go look at the transcript. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/** How often the sweep runs. Cheap: it only reads files for stuck sessions. */
export const SWEEP_INTERVAL_MS = 60 * 1000;

/** Bytes of transcript tail to read. A few entries is all the decision needs. */
export const TAIL_BYTES = 64 * 1024;

export type TranscriptVerdict = "idle" | "needsInput" | "working";

interface TranscriptEntry {
	type?: string;
	role?: string;
	message?: { role?: string; content?: unknown };
	toolUseResult?: unknown;
	isMeta?: boolean;
}

function contentBlocks(entry: TranscriptEntry): Array<{ type?: string }> {
	const content = entry.message?.content;
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is { type?: string } =>
			typeof block === "object" && block !== null,
	);
}

/**
 * Decides what the last meaningful transcript entry means.
 *
 * The reasoning, in the order the checks run:
 *  - an assistant turn whose last block is a `tool_use` with no result after it
 *    means the tool call is outstanding → the agent is genuinely still working
 *    (a long build, a slow network call), so leave it alone;
 *  - a `user` entry that is a `tool_result` is the tool answering, which also
 *    means work is in flight;
 *  - a plain assistant text turn that nothing follows is a finished answer →
 *    `idle`;
 *  - an explicit permission/approval request is `needsInput`.
 *
 * An unreadable or empty tail returns `working`: no evidence is not evidence of
 * completion, and returning `working` is the option that changes nothing.
 */
export function decideStateFromTranscriptTail(
	lines: string[],
): TranscriptVerdict {
	const entries: TranscriptEntry[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as TranscriptEntry;
			if (parsed && typeof parsed === "object" && !parsed.isMeta) {
				entries.push(parsed);
			}
		} catch {
			// A truncated first line is normal — the tail starts mid-file.
		}
	}

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry) continue;
		const type = entry.type ?? entry.message?.role ?? entry.role;

		if (type === "assistant") {
			const blocks = contentBlocks(entry);
			const last = blocks[blocks.length - 1];
			if (last?.type === "tool_use") return "working";
			if (blocks.some((block) => block.type === "text")) return "idle";
			// An assistant entry with no recognisable blocks says nothing.
			continue;
		}

		if (type === "user") {
			const blocks = contentBlocks(entry);
			if (blocks.some((block) => block.type === "tool_result"))
				return "working";
			if (entry.toolUseResult !== undefined) return "working";
			// A real user message with no assistant reply after it: the agent has
			// the turn, so it is working, not waiting on anyone.
			return "working";
		}

		if (
			type === "permission_request" ||
			type === "notification" ||
			type === "tool_permission"
		) {
			return "needsInput";
		}
	}

	return "working";
}

/** Reads the last TAIL_BYTES of a file as lines. Never throws. */
export async function readTranscriptTail(
	transcriptPath: string,
	tailBytes = TAIL_BYTES,
): Promise<string[]> {
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(transcriptPath, "r");
		const { size } = await handle.stat();
		const length = Math.min(size, tailBytes);
		if (length === 0) return [];
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, size - length);
		return buffer.toString("utf-8").split("\n");
	} catch {
		// Missing/unreadable transcript → no lines → the decision stays "working".
		return [];
	} finally {
		await handle?.close().catch(() => {});
	}
}

export async function inspectTranscript(
	transcriptPath: string,
): Promise<TranscriptVerdict> {
	return decideStateFromTranscriptTail(
		await readTranscriptTail(transcriptPath),
	);
}
