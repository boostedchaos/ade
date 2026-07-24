import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MailEvent } from "./github-team";

/**
 * Team-dashboard mail feed (issue #51, unit U3): a read-only roll-up of the
 * agent-mail v1 audit trail. Each agent's mail lives on disk under
 * <agent-home>/mail/{inbox,sent}/*.md as markdown files with YAML frontmatter
 * (see agent-mail.ts `renderThreadFile` for the writer). This module reads that
 * frontmatter — never the message bodies (the thread/inbox UI is deferred to
 * issue #46) — and returns a flat, deduped, newest-first list of mail events.
 *
 * Import-time DB-free and pure filesystem by design, matching agent-mail.ts.
 * NEVER throws: any unreadable directory, file, or frontmatter is skipped.
 */

/** The frontmatter fields agent-mail.ts writes that we care about. */
interface Frontmatter {
	thread?: string;
	from?: string;
	to?: string;
	status?: string;
	asked?: string;
	answered?: string;
}

const SUBJECT_MAX = 120;

/**
 * Minimal YAML-frontmatter parser: agent-mail.ts writes flat `key: value` pairs
 * between two `---` fences with no nesting or quoting, so a line split is enough.
 * Returns the parsed fields plus the body lines that followed the closing fence.
 * Returns null when the file has no frontmatter block.
 */
function parseFrontmatter(
	text: string,
): { fields: Frontmatter; body: string[] } | null {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return null;
	const close = lines.indexOf("---", 1);
	if (close === -1) return null;

	const fields: Frontmatter = {};
	for (let i = 1; i < close; i++) {
		const line = lines[i];
		const sep = line.indexOf(":");
		if (sep === -1) continue;
		const key = line.slice(0, sep).trim();
		const value = line.slice(sep + 1).trim();
		if (key) (fields as Record<string, string>)[key] = value;
	}
	return { fields, body: lines.slice(close + 1) };
}

/**
 * The subject line for the dashboard row. The v1 mail format has no `subject`
 * frontmatter field, so we fall back to the first meaningful body line —
 * skipping blanks and the `## Question` / `## Answer` markdown headings the
 * writer emits — which is the question text. Truncated to ~120 chars.
 */
function deriveSubject(fields: Frontmatter, body: string[]): string {
	// If a future format adds a `subject` field, prefer it.
	const explicit = (fields as Record<string, string>).subject;
	if (explicit) return explicit.slice(0, SUBJECT_MAX);
	for (const raw of body) {
		const line = raw.trim();
		if (!line) continue;
		if (/^#{1,6}\s/.test(line)) continue; // skip markdown headings
		return line.slice(0, SUBJECT_MAX);
	}
	return "";
}

/** Best available timestamp as an ISO string: answered ?? asked ?? file mtime. */
function deriveAt(fields: Frontmatter, filePath: string): string {
	for (const candidate of [fields.answered, fields.asked]) {
		if (candidate) {
			const ms = Date.parse(candidate);
			if (!Number.isNaN(ms)) return new Date(ms).toISOString();
		}
	}
	try {
		return statSync(filePath).mtime.toISOString();
	} catch {
		return new Date(0).toISOString();
	}
}

/** Parse one mail file into a MailEvent, or null if it is unusable/skippable. */
function readMailFile(filePath: string): MailEvent | null {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	const parsed = parseFrontmatter(text);
	if (!parsed) return null;
	const { fields, body } = parsed;
	const thread = fields.thread;
	if (!thread) return null; // no id to key on — skip

	return {
		id: thread,
		thread,
		from: fields.from ?? "",
		to: fields.to ?? "",
		status: fields.status ?? "",
		at: deriveAt(fields, filePath),
		subjectLine: deriveSubject(fields, body),
	};
}

/** List the *.md files in a mailbox dir; empty when the dir is missing/unreadable. */
function listMailboxFiles(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return []; // missing mail dir → skip silently
	}
	return entries
		.filter((name) => name.toLowerCase().endsWith(".md"))
		.map((name) => join(dir, name));
}

/**
 * Roll up agent-mail events across the given agent homes, newest-first.
 *
 * @param agentHomes each agent's display name and its home dir (the parent of
 *   `mail/`). Missing `mail/inbox` or `mail/sent` dirs are skipped silently.
 * @param limit maximum number of events to return.
 */
export async function listMailEvents(
	agentHomes: Array<{ name: string; home: string }>,
	limit: number,
): Promise<MailEvent[]> {
	const byKey = new Map<string, MailEvent>();

	for (const { home } of agentHomes) {
		for (const box of ["inbox", "sent"] as const) {
			const dir = join(home, "mail", box);
			for (const filePath of listMailboxFiles(dir)) {
				const event = readMailFile(filePath);
				if (!event) continue;
				// The same logical message exists in the sender's sent/ and the
				// recipient's inbox/ (identical frontmatter) — dedupe on thread+from+at.
				const key = `${event.thread}|${event.from}|${event.at}`;
				if (!byKey.has(key)) byKey.set(key, event);
			}
		}
	}

	const events = [...byKey.values()];
	events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
	return events.slice(0, Math.max(0, limit));
}
