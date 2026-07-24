import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Verifies the native-Claude-session importer end to end against a throwaway
 * HOME so the user's real ~/.claude is never touched. HOME/USERPROFILE are set
 * BEFORE importing the module so getClaudeProjectsRoot() resolves under it.
 */

const TEST_HOME = join(
	tmpdir(),
	`ade-claude-sessions-${process.pid}-${Date.now()}`,
);
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

let mod: typeof import("./claude-sessions");

const REPO_A = join(TEST_HOME, "code", "repo-a");
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

/** A compact but realistic Claude Code JSONL transcript. */
function fixtureTranscript(cwd: string): string {
	const lines = [
		{ type: "mode", mode: "normal", sessionId: SESSION_ID },
		{
			type: "file-history-snapshot",
			messageId: "x",
			snapshot: {},
		},
		// meta/command noise — must be excluded from counts + render
		{
			type: "user",
			isMeta: true,
			message: { role: "user", content: "<command-name>/clear</command-name>" },
			uuid: "u0",
			timestamp: "2026-07-15T13:00:00.000Z",
			cwd,
			gitBranch: "main",
			version: "2.1.210",
		},
		{
			type: "user",
			message: { role: "user", content: "What is the capital of France?" },
			uuid: "u1",
			timestamp: "2026-07-15T13:01:00.000Z",
			cwd,
			gitBranch: "main",
		},
		{
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "considering geography" },
					{ type: "text", text: "Let me check." },
					{
						type: "tool_use",
						id: "toolu_1",
						name: "Bash",
						input: { command: "echo Paris" },
					},
				],
			},
			uuid: "a1",
			timestamp: "2026-07-15T13:01:05.000Z",
		},
		{
			type: "user",
			message: {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "toolu_1", content: "Paris" },
				],
			},
			uuid: "u2",
			timestamp: "2026-07-15T13:01:06.000Z",
		},
		{
			type: "assistant",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "The capital of France is Paris." }],
			},
			uuid: "a2",
			timestamp: "2026-07-15T13:01:07.000Z",
		},
		{
			type: "ai-title",
			aiTitle: "France capital question",
			sessionId: SESSION_ID,
		},
		{ type: "custom-title", customTitle: "geo-chat", sessionId: SESSION_ID },
	];
	return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

beforeAll(async () => {
	mod = await import("./claude-sessions");
	// Sanity: the env override routes the projects root under TEST_HOME.
	expect(mod.getClaudeProjectsRoot().startsWith(TEST_HOME)).toBe(true);

	// Lay down a native session transcript for REPO_A.
	const projectDir = join(
		mod.getClaudeProjectsRoot(),
		mod.encodeClaudeProjectDir(REPO_A),
	);
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(projectDir, `${SESSION_ID}.jsonl`),
		fixtureTranscript(REPO_A),
		"utf8",
	);

	// A source repo on disk with memory notes to carry over.
	mkdirSync(REPO_A, { recursive: true });
	writeFileSync(
		join(REPO_A, "MEMORY.md"),
		"- prefers Paris over Lyon\n",
		"utf8",
	);
});

afterAll(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("encodeClaudeProjectDir", () => {
	it("matches Claude Code's path hashing", () => {
		expect(
			mod.encodeClaudeProjectDir("C:\\Users\\ccrow\\Projects\\ade-windows-port"),
		).toBe("C--Users-ccrow-Projects-ade-windows-port");
		expect(mod.encodeClaudeProjectDir("/home/me/proj")).toBe("-home-me-proj");
	});
});

describe("parseClaudeTranscript", () => {
	it("normalizes messages, tool calls, and tool results", async () => {
		const projectDir = join(
			mod.getClaudeProjectsRoot(),
			mod.encodeClaudeProjectDir(REPO_A),
		);
		const transcript = await mod.parseClaudeTranscript(
			join(projectDir, `${SESSION_ID}.jsonl`),
		);

		expect(transcript.sessionId).toBe(SESSION_ID);
		expect(transcript.cwd).toBe(REPO_A);
		expect(transcript.gitBranch).toBe("main");
		expect(transcript.version).toBe("2.1.210");
		// custom-title wins over ai-title
		expect(transcript.title).toBe("geo-chat");

		// meta/command line excluded from counts
		expect(transcript.userMessageCount).toBe(2);
		expect(transcript.assistantMessageCount).toBe(2);
		expect(transcript.toolCallCount).toBe(1);

		const withTool = transcript.messages.find((m) => m.toolCalls.length > 0);
		expect(withTool?.toolCalls[0]?.name).toBe("Bash");
		expect(withTool?.thinking).toContain("geography");

		const withResult = transcript.messages.find(
			(m) => m.toolResults.length > 0,
		);
		expect(withResult?.toolResults[0]?.content).toBe("Paris");
	});
});

describe("renderTranscriptMarkdown", () => {
	it("produces a readable, meta-free document", async () => {
		const projectDir = join(
			mod.getClaudeProjectsRoot(),
			mod.encodeClaudeProjectDir(REPO_A),
		);
		const transcript = await mod.parseClaudeTranscript(
			join(projectDir, `${SESSION_ID}.jsonl`),
		);
		const md = mod.renderTranscriptMarkdown(transcript);

		expect(md).toContain("# Imported Claude session");
		expect(md).toContain("What is the capital of France?");
		expect(md).toContain("The capital of France is Paris.");
		expect(md).toContain("Bash");
		expect(md).toContain(`claude --resume ${SESSION_ID}`);
		// meta/command line must not leak into the render
		expect(md).not.toContain("/clear");
	});
});

describe("scanClaudeSessions", () => {
	it("groups sessions by originating repo (cwd)", async () => {
		const groups = await mod.scanClaudeSessions();
		const repoA = groups.find((g) => g.repoPath === REPO_A);
		expect(repoA).toBeDefined();
		expect(repoA?.sessions[0]?.sessionId).toBe(SESSION_ID);
		expect(repoA?.sessions[0]?.title).toBe("geo-chat");
		expect(repoA?.sessions[0]?.firstPrompt).toContain("capital of France");
		// Scanner's display count excludes the tool-result-only user turn
		// (1 real user prompt + 2 assistant replies = 3).
		expect(repoA?.sessions[0]?.messageCount).toBe(3);
	});

	it("listSessionsForRepo returns that repo's sessions", async () => {
		const sessions = await mod.listSessionsForRepo(REPO_A);
		expect(sessions.map((s) => s.sessionId)).toContain(SESSION_ID);
	});
});

describe("readLatestSessionStats", () => {
	// Own repo/bucket so these fixtures never disturb the REPO_A ordering
	// assertions above.
	const REPO_B = join(TEST_HOME, "code", "repo-b");
	const OLD_SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
	const NEW_SESSION = "bbbbbbbb-1111-2222-3333-444444444444";

	const assistantTurn = (
		model: string,
		usage: Record<string, number>,
		extra: Record<string, unknown> = {},
	) => ({
		type: "assistant",
		message: {
			role: "assistant",
			model,
			content: [{ type: "text", text: "..." }],
			usage,
		},
		...extra,
	});

	beforeAll(() => {
		const bucket = join(
			mod.getClaudeProjectsRoot(),
			mod.encodeClaudeProjectDir(REPO_B),
		);
		mkdirSync(bucket, { recursive: true });

		// Older transcript: a different model, must NOT win.
		const oldLines = [
			{ type: "user", message: { role: "user", content: "hi" }, cwd: REPO_B },
			assistantTurn("claude-sonnet-4-5", {
				input_tokens: 10,
				output_tokens: 20,
			}),
		];
		const oldPath = join(bucket, `${OLD_SESSION}.jsonl`);
		writeFileSync(
			oldPath,
			`${oldLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
			"utf8",
		);
		const oldTime = new Date(Date.now() - 60 * 60 * 1000);
		utimesSync(oldPath, oldTime, oldTime);

		// Newest transcript: latest REAL assistant turn carries the stats;
		// trailing sidechain + synthetic entries must be skipped.
		const newLines = [
			{ type: "user", message: { role: "user", content: "go" }, cwd: REPO_B },
			assistantTurn("claude-opus-4-8", {
				input_tokens: 3,
				cache_read_input_tokens: 50_000,
				output_tokens: 100,
			}),
			assistantTurn("claude-opus-4-8", {
				input_tokens: 4,
				cache_read_input_tokens: 120_000,
				cache_creation_input_tokens: 2_000,
				output_tokens: 300,
			}),
			assistantTurn(
				"claude-haiku-4",
				{ input_tokens: 1, output_tokens: 1 },
				{ isSidechain: true },
			),
			{
				type: "assistant",
				message: {
					role: "assistant",
					model: "<synthetic>",
					content: [{ type: "text", text: "error entry" }],
				},
			},
		];
		writeFileSync(
			join(bucket, `${NEW_SESSION}.jsonl`),
			`${newLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
			"utf8",
		);
	});

	it("returns null when the worktree has no Claude sessions", async () => {
		const stats = await mod.readLatestSessionStats(
			join(TEST_HOME, "code", "never-ran-claude"),
		);
		expect(stats).toBeNull();
	});

	it("reads model + context tokens from the newest transcript's latest real assistant turn", async () => {
		const stats = await mod.readLatestSessionStats(REPO_B);
		expect(stats).not.toBeNull();
		expect(stats?.sessionId).toBe(NEW_SESSION);
		expect(stats?.model).toBe("claude-opus-4-8");
		// input + cache_read + cache_creation + output of the LAST real turn
		expect(stats?.contextTokens).toBe(4 + 120_000 + 2_000 + 300);
		expect(stats?.lastModified).toBeGreaterThan(0);
	});

	it("tolerates a transcript with no usage data (fixture from the import tests)", async () => {
		// REPO_A's fixture transcript has assistant turns without model/usage —
		// stats must come back null rather than erroring.
		const stats = await mod.readLatestSessionStats(REPO_A);
		expect(stats).toBeNull();
	});
});

describe("readLatestSessionActivity", () => {
	// Each scenario gets its own cwd/bucket so the newest-file resolution is
	// deterministic (one transcript per bucket) and independent of the fixtures
	// above.
	const minsAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);

	/** Lay one transcript into `cwd`'s bucket and stamp its mtime. */
	const layTranscript = (cwd: string, sessionId: string, body: string, mtime: Date) => {
		const bucket = join(
			mod.getClaudeProjectsRoot(),
			mod.encodeClaudeProjectDir(cwd),
		);
		mkdirSync(bucket, { recursive: true });
		const file = join(bucket, `${sessionId}.jsonl`);
		writeFileSync(file, body, "utf8");
		utimesSync(file, mtime, mtime);
		return file;
	};

	const userLine = (content: string) =>
		JSON.stringify({ type: "user", message: { role: "user", content } });
	const assistantLine = (text: string) =>
		JSON.stringify({
			type: "assistant",
			message: { role: "assistant", content: [{ type: "text", text }] },
		});

	it("reports 'working' when the transcript was touched within 15s", async () => {
		const cwd = join(TEST_HOME, "code", "act-working");
		const id = "10000000-0000-0000-0000-000000000001";
		layTranscript(
			cwd,
			id,
			`${userLine("go")}\n${assistantLine("on it")}\n`,
			new Date(Date.now() - 2 * 1000),
		);
		const act = await mod.readLatestSessionActivity(cwd);
		expect(act.status).toBe("working");
		expect(act.sessionId).toBe(id);
		expect(act.lastModified).toBeGreaterThan(0);
	});

	it("reports 'waiting' in the quiet window when the last turn is the assistant's", async () => {
		const cwd = join(TEST_HOME, "code", "act-waiting");
		const id = "20000000-0000-0000-0000-000000000002";
		layTranscript(
			cwd,
			id,
			`${userLine("question?")}\n${assistantLine("here is your answer")}\n`,
			minsAgo(10),
		);
		const act = await mod.readLatestSessionActivity(cwd);
		expect(act.status).toBe("waiting");
		expect(act.sessionId).toBe(id);
	});

	it("reports 'idle' in the quiet window when the last record is a user turn", async () => {
		const cwd = join(TEST_HOME, "code", "act-user-idle");
		const id = "30000000-0000-0000-0000-000000000003";
		// Assistant turn followed by a trailing user turn (e.g. fresh input the
		// agent hasn't started on): waiting requires the assistant to be last.
		layTranscript(
			cwd,
			id,
			`${assistantLine("done")}\n${userLine("now do the next thing")}\n`,
			minsAgo(10),
		);
		const act = await mod.readLatestSessionActivity(cwd);
		expect(act.status).toBe("idle");
		expect(act.sessionId).toBe(id);
	});

	it("reports 'idle' when the newest transcript is older than 30min", async () => {
		const cwd = join(TEST_HOME, "code", "act-idle-old");
		const id = "40000000-0000-0000-0000-000000000004";
		layTranscript(
			cwd,
			id,
			`${userLine("hi")}\n${assistantLine("hello")}\n`,
			minsAgo(120),
		);
		const act = await mod.readLatestSessionActivity(cwd);
		expect(act.status).toBe("idle");
		expect(act.sessionId).toBe(id);
	});

	it("reports 'idle' with null fields when no session ever ran in the worktree", async () => {
		const act = await mod.readLatestSessionActivity(
			join(TEST_HOME, "code", "act-never-ran"),
		);
		expect(act.status).toBe("idle");
		expect(act.lastModified).toBeNull();
		expect(act.sessionId).toBeNull();
	});

	it("reports 'unknown' for a corrupt transcript in the quiet window", async () => {
		const cwd = join(TEST_HOME, "code", "act-unknown");
		const id = "50000000-0000-0000-0000-000000000005";
		// Windowed mtime forces the content read; unparseable garbage yields no
		// meaningful record ⇒ indeterminate.
		layTranscript(cwd, id, "this is not json at all\n{ broken", minsAgo(5));
		const act = await mod.readLatestSessionActivity(cwd);
		expect(act.status).toBe("unknown");
		expect(act.lastModified).toBeNull();
		expect(act.sessionId).toBeNull();
	});
});

describe("importClaudeSession", () => {
	it("refuses a worktree with no git state", async () => {
		const bareWorktree = join(TEST_HOME, "bare-worktree");
		mkdirSync(bareWorktree, { recursive: true });
		await expect(
			mod.importClaudeSession({
				sessionId: SESSION_ID,
				sourceRepoPath: REPO_A,
				worktreePath: bareWorktree,
				agentMemoryDir: join(TEST_HOME, "agent", "memory"),
				agentHome: join(TEST_HOME, "agent"),
			}),
		).rejects.toThrow(/not a git repo/);
	});

	it("binds the transcript, renders it, and carries over memory", async () => {
		const worktree = join(TEST_HOME, "agents", "agent1", "worktree");
		mkdirSync(join(worktree, ".git"), { recursive: true });
		const agentHome = join(TEST_HOME, "agents", "agent1");
		const agentMemoryDir = join(agentHome, "memory");

		const result = await mod.importClaudeSession({
			sessionId: SESSION_ID,
			sourceRepoPath: REPO_A,
			worktreePath: worktree,
			agentMemoryDir,
			agentHome,
		});

		expect(result.messageCount).toBe(4);
		expect(result.resumeCommand).toBe(`claude --resume ${SESSION_ID}`);

		// Transcript bound into the worktree's own project bucket (resumable).
		expect(existsSync(result.boundTranscriptPath)).toBe(true);
		expect(result.boundTranscriptPath).toContain(
			mod.encodeClaudeProjectDir(worktree),
		);

		// Rendered markdown lands under the agent home's imported/ dir.
		expect(existsSync(result.renderedTranscriptPath)).toBe(true);
		expect(readFileSync(result.renderedTranscriptPath, "utf8")).toContain(
			"capital of France",
		);

		// Memory carried over from the source repo's MEMORY.md.
		expect(result.memoryFilesImported).toContain("MEMORY.md");
		const importedMemory = readFileSync(
			join(agentMemoryDir, "MEMORY.md"),
			"utf8",
		);
		expect(importedMemory).toContain("prefers Paris over Lyon");

		// Surfaced for Agent Files.
		const transcripts = await mod.listImportedTranscripts(agentHome);
		expect(transcripts.map((t) => t.label)).toContain(
			`imported/${SESSION_ID}.md`,
		);
	});

	it("is idempotent for memory carry-over on re-import", async () => {
		const worktree = join(TEST_HOME, "agents", "agent1", "worktree");
		const agentHome = join(TEST_HOME, "agents", "agent1");
		const agentMemoryDir = join(agentHome, "memory");

		await mod.importClaudeSession({
			sessionId: SESSION_ID,
			sourceRepoPath: REPO_A,
			worktreePath: worktree,
			agentMemoryDir,
			agentHome,
		});
		const memory = readFileSync(join(agentMemoryDir, "MEMORY.md"), "utf8");
		const occurrences = memory.split("prefers Paris over Lyon").length - 1;
		expect(occurrences).toBe(1);
	});
});
