import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMailEvents } from "./mail-events";

/**
 * mail-events unit tests (issue #51). Builds throwaway agent-home fixtures with
 * hand-written mail files that mirror agent-mail.ts's `renderThreadFile` format,
 * then exercises ordering, limit, dedupe, missing dirs, and corrupt frontmatter.
 * Pure filesystem — no DB, no module env setup needed.
 */

const ROOT = join(tmpdir(), `ade-mailevents-test-${process.pid}-${Date.now()}`);

interface MailFields {
	thread: string;
	from: string;
	to: string;
	asked?: string;
	answered?: string;
	status?: string;
	question?: string;
	answer?: string;
}

/** Render a mail file exactly like agent-mail.ts renderThreadFile does. */
function renderMail(f: MailFields): string {
	return [
		"---",
		`thread: ${f.thread}`,
		`from: ${f.from}`,
		`to: ${f.to}`,
		`asked: ${f.asked ?? ""}`,
		`answered: ${f.answered ?? ""}`,
		`status: ${f.status ?? "pending"}`,
		"depth: 1",
		"---",
		"",
		"## Question",
		"",
		f.question ?? "A question?",
		"",
		"## Answer",
		"",
		f.answer ?? "_(pending)_",
		"",
	].join("\n");
}

/** Write a mail file into <home>/mail/<box>/<name>.md. Returns its path. */
function writeMail(
	home: string,
	box: "inbox" | "sent",
	name: string,
	content: string,
): string {
	const dir = join(home, "mail", box);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${name}.md`);
	writeFileSync(path, content, "utf8");
	return path;
}

const HOME_A = join(ROOT, "agent-a");
const HOME_B = join(ROOT, "agent-b");
const HOMES = [
	{ name: "Alice", home: HOME_A },
	{ name: "Bob", home: HOME_B },
];

beforeAll(() => {
	mkdirSync(ROOT, { recursive: true });

	// Three answered exchanges at distinct times, plus one pending.
	// t1 (oldest) — Alice asked Bob.
	writeMail(
		HOME_A,
		"sent",
		"m1-sent",
		renderMail({
			thread: "t1",
			from: "Alice",
			to: "Bob",
			asked: "2026-07-10T00:00:00.000Z",
			answered: "2026-07-10T00:05:00.000Z",
			status: "answered",
			question: "Oldest question about budgets?",
		}),
	);
	// Same logical message in Bob's inbox — must dedupe with the sent copy.
	writeMail(
		HOME_B,
		"inbox",
		"m1-inbox",
		renderMail({
			thread: "t1",
			from: "Alice",
			to: "Bob",
			asked: "2026-07-10T00:00:00.000Z",
			answered: "2026-07-10T00:05:00.000Z",
			status: "answered",
			question: "Oldest question about budgets?",
		}),
	);

	// t2 (middle) — Bob asked Alice.
	writeMail(
		HOME_B,
		"sent",
		"m2-sent",
		renderMail({
			thread: "t2",
			from: "Bob",
			to: "Alice",
			asked: "2026-07-12T00:00:00.000Z",
			answered: "2026-07-12T00:01:00.000Z",
			status: "answered",
			question: "Middle question?",
		}),
	);

	// t3 (newest) — Alice asked Bob, still pending (no answered ts → uses asked).
	writeMail(
		HOME_A,
		"sent",
		"m3-sent",
		renderMail({
			thread: "t3",
			from: "Alice",
			to: "Bob",
			asked: "2026-07-15T00:00:00.000Z",
			status: "pending",
			question: "Newest question, still pending?",
		}),
	);
});

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe("listMailEvents", () => {
	it("returns newest-first and dedupes the sent/inbox copies of a message", async () => {
		const events = await listMailEvents(HOMES, 100);
		// t1 appears twice on disk (Alice sent + Bob inbox) but once here.
		expect(events.map((e) => e.thread)).toEqual(["t3", "t2", "t1"]);
		expect(events).toHaveLength(3);
	});

	it("uses answered ?? asked for `at`", async () => {
		const events = await listMailEvents(HOMES, 100);
		const t1 = events.find((e) => e.thread === "t1");
		const t3 = events.find((e) => e.thread === "t3");
		expect(t1?.at).toBe("2026-07-10T00:05:00.000Z"); // answered wins
		expect(t3?.at).toBe("2026-07-15T00:00:00.000Z"); // falls back to asked
	});

	it("derives subjectLine from the question body (no subject frontmatter)", async () => {
		const events = await listMailEvents(HOMES, 100);
		const t2 = events.find((e) => e.thread === "t2");
		expect(t2?.subjectLine).toBe("Middle question?");
		expect(t2?.from).toBe("Bob");
		expect(t2?.to).toBe("Alice");
		expect(t2?.status).toBe("answered");
	});

	it("honors the limit after sorting", async () => {
		const events = await listMailEvents(HOMES, 2);
		expect(events.map((e) => e.thread)).toEqual(["t3", "t2"]);
	});

	it("skips agent homes whose mail dir is missing", async () => {
		const events = await listMailEvents(
			[...HOMES, { name: "Ghost", home: join(ROOT, "no-such-agent") }],
			100,
		);
		expect(events).toHaveLength(3); // ghost contributes nothing, no throw
	});

	it("skips files with corrupt / missing frontmatter without throwing", async () => {
		const home = join(ROOT, "agent-corrupt");
		writeMail(home, "sent", "no-frontmatter", "just some text\nno fences here");
		writeMail(home, "sent", "unterminated", "---\nthread: x\nfrom: Z\n");
		writeMail(home, "sent", "no-thread", renderMailWithoutThread());
		writeMail(
			home,
			"sent",
			"good",
			renderMail({
				thread: "t-good",
				from: "Zoe",
				to: "Alice",
				asked: "2026-07-16T00:00:00.000Z",
				answered: "2026-07-16T00:00:30.000Z",
				status: "answered",
				question: "Valid amid the corrupt ones?",
			}),
		);
		const events = await listMailEvents([{ name: "Zoe", home }], 100);
		// Only the one well-formed file survives.
		expect(events.map((e) => e.thread)).toEqual(["t-good"]);
	});

	it("returns an empty array for an empty limit and never throws on no homes", async () => {
		expect(await listMailEvents(HOMES, 0)).toEqual([]);
		expect(await listMailEvents([], 100)).toEqual([]);
	});

	it("falls back to file mtime when no timestamps are present", async () => {
		const home = join(ROOT, "agent-mtime");
		const path = writeMail(
			home,
			"inbox",
			"mtimey",
			renderMail({ thread: "t-mtime", from: "A", to: "B" }),
		);
		const when = new Date("2026-01-02T03:04:05.000Z");
		utimesSync(path, when, when);
		const events = await listMailEvents([{ name: "M", home }], 100);
		expect(events[0]?.at).toBe(when.toISOString());
	});
});

/** A mail file missing the `thread` id — must be skipped (no dedupe key). */
function renderMailWithoutThread(): string {
	return [
		"---",
		"from: Nobody",
		"to: Alice",
		"asked: 2026-07-16T00:00:00.000Z",
		"status: answered",
		"---",
		"",
		"## Question",
		"",
		"Missing a thread id?",
		"",
	].join("\n");
}
