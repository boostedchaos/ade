import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime } from "@superset/local-db";
import { getAgentCodexHome, getAgentHome } from "./agent-home";
import { regenerateCodexAgentsMd } from "./agent-scaffold";
import { getSupersetHomeDir } from "./app-environment";
import { env } from "./env.shared";
import { buildSafeEnv, sanitizeEnv } from "./terminal/env";
import { treeKillAsync } from "./tree-kill";

/**
 * Agent mail v1 (issue #45): one agent asks a named sibling a question; the
 * server answers it by spawning a headless one-shot session of the recipient
 * (its runtime CLI, its memory bridges, cwd = its worktree) and capturing the
 * reply. Mail folders under <agent-home>/mail/ are the audit trail, not the
 * transport.
 *
 * Import-time DB-free by design (bun-on-Windows test constraint): recipient
 * resolution lives in the routers; this module takes already-resolved parties.
 */

/** Hop-depth guardrail: A→B→C is allowed; C cannot ask further. */
export const MAIL_MAX_DEPTH = 2;
/** Env var carrying the hop depth into a spawned answerer session. */
export const MAIL_DEPTH_ENV = "ADE_MAIL_DEPTH";
/** How long the asker blocks before the exchange goes background. */
export const DEFAULT_MAIL_TIMEOUT_MS = 5 * 60_000;
// ponytail: one hard cap instead of progress heuristics — a runaway answerer
// is killed outright after 30 min; raise if real exchanges ever run longer.
const HARD_KILL_MS = 30 * 60_000;
const MAX_CAPTURE_BYTES = 1_000_000;

export interface MailParty {
	id: string;
	name: string;
}

export interface MailRecipient extends MailParty {
	runtime: AgentRuntime;
	worktreePath: string;
}

export interface AskAgentParams {
	from: MailParty;
	to: MailRecipient;
	question: string;
	/** The ASKER's current hop depth (its ADE_MAIL_DEPTH; 0 for human-started sessions). */
	depth: number;
	timeoutMs?: number;
	/** Decrypted OpenRouter key for the OpenRouter-routed runtimes (kimi/minimax/glm). */
	openRouterKey?: string | null;
}

export type AskAgentResult =
	| { status: "answered"; answer: string; threadFile: string }
	| { status: "timeout"; threadFile: string };

/** A refused ask (depth exceeded, unsupported runtime, bad input). */
export class MailError extends Error {}

interface OneShotCommand {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

const OPENROUTER_MODELS: Partial<Record<AgentRuntime, string>> = {
	kimi: "moonshotai/kimi-k2.7-code",
	minimax: "minimax/minimax-m3",
	glm: "z-ai/glm-5.2",
};

/**
 * The headless one-shot launch for a runtime. The prompt is always delivered
 * over stdin — argv stays fixed literals, so spawning through a shell (needed
 * for npm .cmd shims on Windows) is quoting-safe. Mirrors the interactive
 * presets in @superset/shared agent-command.ts.
 * Returns null for runtimes without a known one-shot mode (v1).
 */
export function buildOneShotCommand(
	runtime: AgentRuntime,
	opts?: { openRouterKey?: string | null },
): OneShotCommand | null {
	const openRouterModel = OPENROUTER_MODELS[runtime];
	if (runtime === "claude" || openRouterModel) {
		const args = ["-p", "--dangerously-skip-permissions"];
		if (!openRouterModel) return { command: "claude", args };
		return {
			command: "claude",
			args: [...args, "--model", openRouterModel],
			env: {
				ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
				ANTHROPIC_AUTH_TOKEN: opts?.openRouterKey ?? "",
				ANTHROPIC_API_KEY: "",
			},
		};
	}
	if (runtime === "codex") {
		// "-" = read the prompt from stdin.
		return {
			command: "codex",
			args: [
				"exec",
				"--ask-for-approval",
				"never",
				"--sandbox",
				"danger-full-access",
				"-",
			],
		};
	}
	if (runtime === "opencode") {
		return { command: "opencode", args: ["run"] };
	}
	return null;
}

/** Root of an agent's mail dir: <agent-home>/mail/{inbox,sent}. */
export function getAgentMailDir(agentId: string): string {
	return join(getAgentHome(agentId), "mail");
}

export interface ThreadFileParams {
	threadId: string;
	from: string;
	to: string;
	asked: string;
	answered: string;
	status: "pending" | "answered" | "answered-late" | "timeout" | "error";
	depth: number;
	question: string;
	answer: string;
}

/**
 * The v1 thread-file format — the contract the future mail UI (issue #46)
 * builds on. Frontmatter carries the routing metadata; body is the exchange.
 */
export function renderThreadFile(t: ThreadFileParams): string {
	return [
		"---",
		`thread: ${t.threadId}`,
		`from: ${t.from}`,
		`to: ${t.to}`,
		`asked: ${t.asked}`,
		`answered: ${t.answered}`,
		`status: ${t.status}`,
		`depth: ${t.depth}`,
		"---",
		"",
		"## Question",
		"",
		t.question,
		"",
		"## Answer",
		"",
		t.answer || "_(pending)_",
		"",
	].join("\n");
}

function slug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "agent"
	);
}

function stamp(d: Date): string {
	return d.toISOString().replace(/:/g, "-").replace(/\..*$/, "");
}

function writeMailFile(
	agentId: string,
	box: "inbox" | "sent",
	fileName: string,
	content: string,
): string {
	const dir = join(getAgentMailDir(agentId), box);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, fileName);
	writeFileSync(path, content, "utf8");
	return path;
}

/**
 * Verify a presented bearer token against ~/.ade/token — the same
 * single-user token ade-server auth uses. Reads the file per call
 * (tokens rotate); false when the file is absent (e.g. desktop-only install).
 */
export function verifyMailToken(presented: string | undefined): boolean {
	if (!presented) return false;
	let expected: string;
	try {
		expected = readFileSync(join(getSupersetHomeDir(), "token"), "utf8").trim();
	} catch {
		return false;
	}
	if (expected.length < 32) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}

interface SpawnOutcome {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Spawn a one-shot command, feed it the prompt on stdin, and capture output.
 * Exported for unit tests (which substitute `node -e` for a real agent CLI).
 * On timeout the promise from `wait()` keeps running — the caller decides
 * whether to keep listening (late answer) — and a hard-kill timer reaps the
 * process tree after HARD_KILL_MS.
 */
export function spawnOneShot(
	shot: OneShotCommand,
	opts: {
		cwd: string;
		env: Record<string, string>;
		prompt: string;
	},
): { child: ChildProcess; wait: Promise<SpawnOutcome> } {
	const child = spawn(shot.command, shot.args, {
		cwd: opts.cwd,
		env: { ...opts.env, ...shot.env },
		// npm-installed CLIs are .cmd shims on Windows; argv is fixed literals
		// (the prompt travels via stdin), so a shell is quoting-safe here.
		shell: process.platform === "win32",
		windowsHide: true,
	});

	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (d: Buffer) => {
		if (stdout.length < MAX_CAPTURE_BYTES) stdout += d.toString("utf8");
	});
	child.stderr?.on("data", (d: Buffer) => {
		if (stderr.length < MAX_CAPTURE_BYTES) stderr += d.toString("utf8");
	});
	child.stdin?.on("error", () => {
		// A CLI that exits before reading stdin (missing binary, bad flag) EPIPEs
		// the write; the close handler below reports the real failure.
	});
	child.stdin?.end(opts.prompt);

	const wait = new Promise<SpawnOutcome>((resolve, reject) => {
		const hardKill = setTimeout(() => {
			if (child.pid) void treeKillAsync(child.pid, "SIGKILL");
		}, HARD_KILL_MS);
		child.once("error", (err) => {
			clearTimeout(hardKill);
			reject(err);
		});
		child.once("close", (code) => {
			clearTimeout(hardKill);
			resolve({ code, stdout, stderr });
		});
	});

	return { child, wait };
}

/**
 * Ask `to` a question on behalf of `from`. Blocks up to `timeoutMs`; within
 * the window the answer is returned in-turn. On timeout the exchange keeps
 * running in the background and the late answer is delivered to the asker's
 * inbox. Both agents get a thread file the moment the ask starts (status
 * pending), so the audit trail survives a crash mid-exchange.
 */
export async function askAgent(
	params: AskAgentParams,
): Promise<AskAgentResult> {
	const question = params.question.trim();
	if (!question) throw new MailError("Question must not be empty");
	if (params.from.id === params.to.id) {
		throw new MailError("An agent cannot mail itself");
	}

	const nextDepth = params.depth + 1;
	if (nextDepth > MAIL_MAX_DEPTH) {
		throw new MailError(
			`Ask refused: hop depth ${nextDepth} exceeds the limit of ${MAIL_MAX_DEPTH}. ` +
				"You are answering a chained ask — answer from your own knowledge instead.",
		);
	}

	const shot = buildOneShotCommand(params.to.runtime, {
		openRouterKey: params.openRouterKey,
	});
	if (!shot) {
		throw new MailError(
			`Agent mail does not support the "${params.to.runtime}" runtime yet`,
		);
	}
	if (!existsSync(params.to.worktreePath)) {
		throw new MailError(
			`${params.to.name}'s worktree is missing (agent still initializing?)`,
		);
	}

	const threadId = randomUUID();
	const asked = new Date();
	const fileName = `${stamp(asked)}-${slug(params.from.name)}-to-${slug(params.to.name)}-${threadId.slice(0, 8)}.md`;
	const base: ThreadFileParams = {
		threadId,
		from: params.from.name,
		to: params.to.name,
		asked: asked.toISOString(),
		answered: "",
		status: "pending",
		depth: nextDepth,
		question,
		answer: "",
	};
	const askerFile = writeMailFile(
		params.from.id,
		"sent",
		fileName,
		renderThreadFile(base),
	);
	const recipientFile = writeMailFile(
		params.to.id,
		"inbox",
		fileName,
		renderThreadFile(base),
	);

	const prompt = [
		`You are answering a question from your sibling agent "${params.from.name}" via ADE agent mail.`,
		"Answer from your own knowledge, memory, and repository. Be direct and complete — your reply text is delivered verbatim to the asker.",
		"",
		question,
	].join("\n");

	// Codex reads the concatenated bridge from CODEX_HOME; refresh it like the
	// interactive launch path does.
	if (params.to.runtime === "codex") {
		try {
			regenerateCodexAgentsMd(params.to.id);
		} catch {
			// Bridge refresh is best-effort; a stale AGENTS.md still answers.
		}
	}

	const childEnv: Record<string, string> = {
		...buildSafeEnv(sanitizeEnv(process.env) ?? {}),
		[MAIL_DEPTH_ENV]: String(nextDepth),
		SUPERSET_WORKSPACE_ID: params.to.id,
		SUPERSET_WORKSPACE_NAME: params.to.name,
		SUPERSET_WORKSPACE_PATH: params.to.worktreePath,
		SUPERSET_PORT: String(env.DESKTOP_NOTIFICATIONS_PORT),
		SUPERSET_ENV: env.NODE_ENV === "development" ? "development" : "production",
	};
	if (params.to.runtime === "codex") {
		childEnv.CODEX_HOME = getAgentCodexHome(params.to.id);
	}

	const { wait: rawWait } = spawnOneShot(shot, {
		cwd: params.to.worktreePath,
		env: childEnv,
		prompt,
	});
	// A spawn rejection (e.g. missing runtime binary) must still finalize the
	// thread files — fold it into a failed outcome instead of leaving both
	// copies stuck at status: pending.
	const wait = rawWait.catch(
		(err): SpawnOutcome => ({
			code: null,
			stdout: "",
			stderr: err instanceof Error ? err.message : String(err),
		}),
	);

	const finalize = (outcome: SpawnOutcome, late: boolean): string => {
		const answered = new Date().toISOString();
		const answer = outcome.stdout.trim();
		const failed = outcome.code !== 0 || !answer;
		const status = failed ? "error" : late ? "answered-late" : "answered";
		const body = failed
			? `The one-shot session failed (exit ${outcome.code}).\n\n${outcome.stderr.trim().slice(-1000)}`
			: answer;
		const rendered = renderThreadFile({
			...base,
			answered,
			status,
			answer: body,
		});
		writeFileSync(askerFile, rendered, "utf8");
		writeFileSync(recipientFile, rendered, "utf8");
		if (late) {
			// The asker's session already moved on — deliver to its inbox so the
			// next session (or the user) finds the answer.
			writeMailFile(params.from.id, "inbox", fileName, rendered);
		}
		if (failed) {
			throw new MailError(
				`${params.to.name} failed to answer (exit ${outcome.code}): ${outcome.stderr.trim().slice(-500) || "no output"}`,
			);
		}
		return answer;
	};

	const timeoutMs = params.timeoutMs ?? DEFAULT_MAIL_TIMEOUT_MS;
	let timeoutHandle: NodeJS.Timeout | undefined;
	const timedOut = new Promise<"timeout">((resolve) => {
		timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
	});

	const first = await Promise.race([wait, timedOut]);
	clearTimeout(timeoutHandle);

	if (first === "timeout") {
		// Complete in the background; swallow errors (they're archived in the
		// thread files, and there is no caller left to throw to).
		void wait
			.then((outcome) => {
				try {
					finalize(outcome, true);
				} catch {
					/* archived as status: error */
				}
			})
			.catch(() => {});
		return { status: "timeout", threadFile: askerFile };
	}

	return {
		status: "answered",
		answer: finalize(first, false),
		threadFile: askerFile,
	};
}
