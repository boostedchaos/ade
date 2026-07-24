import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Agent-mail unit + end-to-end tests (issue #45). Runs against a throwaway
 * ADE_HOME_DIR (set before any module import resolves paths) and a fake
 * `claude` CLI shim on PATH, so no real agent runtime or DB is needed —
 * agent-mail is import-time DB-free by design.
 */

const TEST_HOME = join(tmpdir(), `ade-mail-test-${process.pid}-${Date.now()}`);
process.env.ADE_HOME_DIR = TEST_HOME;

const TEST_BIN = join(TEST_HOME, "bin");
const ORIGINAL_PATH = process.env.PATH;

let mail: typeof import("./agent-mail");
let getAgentHome: (id: string) => string;

const ASKER = { id: "asker-1", name: "Nutritionist" };
const RECIPIENT_ID = "recipient-1";

function recipient(runtime: import("@superset/local-db").AgentRuntime) {
	return {
		id: RECIPIENT_ID,
		name: "Financial Advisor",
		runtime,
		worktreePath: join(TEST_HOME, "agents", RECIPIENT_ID, "worktree"),
	};
}

/**
 * A fake `claude` CLI: reads the prompt from stdin and echoes it back with a
 * marker prefix. `SLEEP_MS` (via argv sentinel file) simulates a slow answer.
 */
function installFakeClaude(): void {
	mkdirSync(TEST_BIN, { recursive: true });
	const echoJs = join(TEST_BIN, "echo.cjs");
	writeFileSync(
		echoJs,
		[
			'const fs = require("node:fs");',
			'const path = require("node:path");',
			'let input = "";',
			'try { input = fs.readFileSync(0, "utf8"); } catch {}',
			// buildSafeEnv strips custom env vars from the child, so the slow-answer
			// switch is a sentinel file next to the shim, not an env var.
			'const sleepFlag = path.join(__dirname, "..", "sleep-flag");',
			"const delay = fs.existsSync(sleepFlag) ? 1500 : 0;",
			"setTimeout(() => {",
			'  process.stdout.write("FAKE-ANSWER: " + input.trim().split("\\n").pop());',
			"}, delay);",
		].join("\n"),
		"utf8",
	);
	if (process.platform === "win32") {
		writeFileSync(
			join(TEST_BIN, "claude.cmd"),
			`@node "%~dp0echo.cjs" %*\r\n`,
			"utf8",
		);
	} else {
		const shim = join(TEST_BIN, "claude");
		writeFileSync(
			shim,
			`#!/bin/sh\nexec node "$(dirname "$0")/echo.cjs" "$@"\n`,
			"utf8",
		);
		chmodSync(shim, 0o755);
	}
	process.env.PATH = `${TEST_BIN}${delimiter}${ORIGINAL_PATH ?? ""}`;
}

beforeAll(async () => {
	installFakeClaude();
	mail = await import("./agent-mail");
	const home = await import("./agent-home");
	getAgentHome = home.getAgentHome;
	expect(getAgentHome("x").startsWith(TEST_HOME)).toBe(true);
	mkdirSync(recipient("claude").worktreePath, { recursive: true });
});

afterAll(() => {
	process.env.PATH = ORIGINAL_PATH;
	rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("buildOneShotCommand", () => {
	it("maps claude to a stdin-prompt print run", () => {
		const shot = mail.buildOneShotCommand("claude");
		expect(shot).toEqual({
			command: "claude",
			args: ["-p", "--dangerously-skip-permissions"],
		});
	});

	it("routes kimi through claude + OpenRouter env", () => {
		const shot = mail.buildOneShotCommand("kimi", { openRouterKey: "sk-x" });
		expect(shot?.command).toBe("claude");
		expect(shot?.args).toContain("--model");
		expect(shot?.args).toContain("moonshotai/kimi-k2.7-code");
		expect(shot?.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-x");
		expect(shot?.env?.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
	});

	it("maps codex to `codex exec -` and opencode to `opencode run`", () => {
		expect(mail.buildOneShotCommand("codex")?.args).toContain("-");
		expect(mail.buildOneShotCommand("opencode")?.args).toEqual(["run"]);
	});

	it("returns null for runtimes without a one-shot mode", () => {
		expect(mail.buildOneShotCommand("gemini")).toBeNull();
		expect(mail.buildOneShotCommand("copilot")).toBeNull();
	});
});

describe("renderThreadFile", () => {
	it("renders frontmatter + question/answer sections", () => {
		const text = mail.renderThreadFile({
			threadId: "t-1",
			from: "A",
			to: "B",
			asked: "2026-07-16T00:00:00.000Z",
			answered: "",
			status: "pending",
			depth: 1,
			question: "Q?",
			answer: "",
		});
		expect(text).toContain("thread: t-1");
		expect(text).toContain("from: A");
		expect(text).toContain("to: B");
		expect(text).toContain("status: pending");
		expect(text).toContain("depth: 1");
		expect(text).toContain("## Question");
		expect(text).toContain("_(pending)_");
	});
});

describe("verifyMailToken", () => {
	it("accepts the ~/.ade/token contents and rejects anything else", () => {
		const token = "a".repeat(64);
		mkdirSync(TEST_HOME, { recursive: true });
		writeFileSync(join(TEST_HOME, "token"), `${token}\n`, "utf8");
		expect(mail.verifyMailToken(token)).toBe(true);
		expect(mail.verifyMailToken("b".repeat(64))).toBe(false);
		expect(mail.verifyMailToken(undefined)).toBe(false);
	});
});

describe("askAgent — refusals", () => {
	it("refuses beyond the hop-depth limit", async () => {
		await expect(
			mail.askAgent({
				from: ASKER,
				to: recipient("claude"),
				question: "Q?",
				depth: mail.MAIL_MAX_DEPTH,
			}),
		).rejects.toThrow(/hop depth/);
	});

	it("refuses self-mail", async () => {
		await expect(
			mail.askAgent({
				from: { id: RECIPIENT_ID, name: "Financial Advisor" },
				to: recipient("claude"),
				question: "Q?",
				depth: 0,
			}),
		).rejects.toThrow(/cannot mail itself/);
	});

	it("refuses unsupported runtimes", async () => {
		await expect(
			mail.askAgent({
				from: ASKER,
				to: recipient("gemini"),
				question: "Q?",
				depth: 0,
			}),
		).rejects.toThrow(/does not support/);
	});
});

describe("askAgent — end to end (fake claude)", () => {
	it("returns the answer in-turn and archives the thread in both mailboxes", async () => {
		const question = "What is our grocery budget this week?";
		const result = await mail.askAgent({
			from: ASKER,
			to: recipient("claude"),
			question,
			depth: 0,
			timeoutMs: 30_000,
		});
		if (result.status !== "answered") throw new Error("expected an answer");
		expect(result.answer).toContain("FAKE-ANSWER:");
		expect(result.answer).toContain(question);

		const sent = readFileSync(result.threadFile, "utf8");
		expect(sent).toContain("status: answered");
		expect(sent).toContain(question);
		expect(sent).toContain("FAKE-ANSWER:");

		const inboxDir = join(mail.getAgentMailDir(RECIPIENT_ID), "inbox");
		const inboxFiles = readdirSync(inboxDir).filter((f) => f.endsWith(".md"));
		expect(inboxFiles.length).toBeGreaterThan(0);
	});

	it("delivers a late answer to the asker's inbox after timeout", async () => {
		const sleepFile = join(TEST_HOME, "sleep-flag");
		writeFileSync(sleepFile, "1", "utf8");
		try {
			const result = await mail.askAgent({
				from: ASKER,
				to: recipient("claude"),
				question: "Slow question?",
				depth: 0,
				timeoutMs: 200,
			});
			expect(result.status).toBe("timeout");
			const pending = readFileSync(result.threadFile, "utf8");
			expect(pending).toContain("status: pending");

			// The child finishes ~1.5s in; the late answer lands in the asker's inbox.
			const askerInbox = join(mail.getAgentMailDir(ASKER.id), "inbox");
			const deadline = Date.now() + 15_000;
			let lateFile: string | undefined;
			while (Date.now() < deadline && !lateFile) {
				if (existsSync(askerInbox)) {
					lateFile = readdirSync(askerInbox).find((f) =>
						readFileSync(join(askerInbox, f), "utf8").includes(
							"status: answered-late",
						),
					);
				}
				if (!lateFile) await new Promise((r) => setTimeout(r, 100));
			}
			expect(lateFile).toBeDefined();
		} finally {
			rmSync(sleepFile, { force: true });
		}
	}, 30_000);
});
