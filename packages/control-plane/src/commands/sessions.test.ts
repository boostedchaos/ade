import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentSessionSnapshot,
	AgentSessionsHost,
	ControlPlaneHost,
} from "../host";
import { NdjsonParser } from "../ndjson";
import { ControlPlaneServer } from "../server";
import type { ControlPlaneSnapshot } from "../snapshot";
import { phase1Commands } from "./index";

/**
 * Socket-isolated, following the daemon test idiom: every server here binds
 * inside its own mkdtemp directory, so a test run can never reach the live
 * ~/.ade/control.sock of the developer's running app.
 */
const tempDirs: string[] = [];
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const EMPTY_SNAPSHOT: ControlPlaneSnapshot = {
	panes: {},
	tabs: [],
	activeTabIds: {},
	focusedPaneIds: {},
	tabLayouts: {},
	focusedWorkspaceId: null,
	workspaceOrder: [],
};

const SESSION: AgentSessionSnapshot = {
	surfaceId: "pane-1",
	workspaceId: "ws-1",
	agentKind: "claude",
	sessionId: "sess-1",
	transcriptPath: "/tmp/t.jsonl",
	state: "working",
	pid: 4242,
	lastActivityAt: 1_700_000_000_000,
};

function makeHost(agents?: Partial<AgentSessionsHost>): ControlPlaneHost {
	return {
		appVersion: "test",
		getSnapshot: () => EMPTY_SNAPSHOT,
		listWorkspaces: () => [],
		resolveProjectId: () => null,
		dispatchToRenderer: async () => ({}),
		terminal: {
			write: () => {},
			getSession: () => null,
			readScrollback: async () => null,
		},
		agents: agents
			? ({
					listSessions: () => [SESSION],
					ingestEvent: () => ({ from: "idle", to: "working" }),
					setupHooks: (agent: string) => ({
						agent,
						settingsPath: "/tmp/claude-settings.json",
						changed: true,
						backupPath: null,
						registered: ["Stop"],
						missing: [],
					}),
					hooksStatus: (agent: string) => ({
						agent,
						settingsPath: "/tmp/claude-settings.json",
						present: true,
						registered: ["Stop"],
						missing: ["SessionEnd"],
					}),
					...agents,
				} as AgentSessionsHost)
			: undefined,
		log: () => {},
	};
}

class Client {
	private readonly parser = new NdjsonParser<Record<string, unknown>>();
	private readonly frames: Record<string, unknown>[] = [];

	private constructor(private readonly socket: Socket) {
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const value of this.parser.parse(chunk).values) {
				this.frames.push(value);
			}
		});
	}

	static connect(path: string): Promise<Client> {
		return new Promise((resolve, reject) => {
			const socket = createConnection(path);
			socket.once("error", reject);
			socket.once("connect", () => resolve(new Client(socket)));
		});
	}

	send(value: unknown): void {
		this.socket.write(`${JSON.stringify(value)}\n`);
	}

	async waitFor(
		count: number,
		timeoutMs = 3000,
	): Promise<Record<string, unknown>[]> {
		const deadline = Date.now() + timeoutMs;
		while (this.frames.length < count && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
		return this.frames;
	}

	destroy(): void {
		this.socket.destroy();
	}
}

async function withServer(
	host: ControlPlaneHost,
	run: (
		send: (
			cmd: string,
			args?: Record<string, unknown>,
		) => Promise<Record<string, unknown>>,
	) => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "ade-sessions-"));
	tempDirs.push(dir);
	const server = new ControlPlaneServer({
		socketPath: join(dir, "control.sock"),
		tokenPath: join(dir, "control.token"),
		host,
		commands: phase1Commands,
	});
	await server.start();
	const token = readFileSync(join(dir, "control.token"), "utf-8").trim();
	const client = await Client.connect(join(dir, "control.sock"));
	client.send({ id: "hello", cmd: "hello", token });
	await client.waitFor(1);

	let next = 0;
	try {
		await run(async (cmd, args) => {
			next += 1;
			const id = `r${next}`;
			client.send({ id, cmd, args });
			const frames = await client.waitFor(next + 1);
			const frame = frames.find((f) => f.id === id);
			if (!frame) throw new Error(`no response for ${cmd}`);
			return frame;
		});
	} finally {
		client.destroy();
		await server.stop();
	}
}

const IS_WIN = process.platform === "win32";

describe.skipIf(IS_WIN)("agent-sessions", () => {
	it("lists tracked sessions with state and lastActivityAt", async () => {
		await withServer(makeHost({}), async (send) => {
			const frame = await send("agent-sessions");
			expect(frame.ok).toBe(true);
			const sessions = (frame.result as { sessions: Record<string, unknown>[] })
				.sessions;
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				surfaceId: "pane-1",
				state: "working",
				lastActivityAt: 1_700_000_000_000,
			});
		});
	});

	it("answers UNSUPPORTED on a build with no session tracking", async () => {
		await withServer(makeHost(), async (send) => {
			const frame = await send("agent-sessions");
			expect(frame.ok).toBe(false);
			expect((frame.error as { code: string }).code).toBe("UNSUPPORTED");
		});
	});
});

describe.skipIf(IS_WIN)("agent-event", () => {
	it("forwards the event to the host ingest path and reports the transition", async () => {
		let seen: unknown;
		const host = makeHost({
			ingestEvent: (input) => {
				seen = input;
				return { from: "idle", to: "working" };
			},
		});
		await withServer(host, async (send) => {
			const frame = await send("agent-event", {
				surfaceId: "pane-9",
				event: "UserPromptSubmit",
				sessionId: "s1",
				transcriptPath: "/tmp/x.jsonl",
			});
			expect(frame.ok).toBe(true);
			expect(frame.result).toEqual({
				applied: true,
				from: "idle",
				to: "working",
			});
		});
		expect(seen).toMatchObject({
			surfaceId: "pane-9",
			eventType: "UserPromptSubmit",
			sessionId: "s1",
			transcriptPath: "/tmp/x.jsonl",
		});
	});

	it("reports applied:false when the event changed nothing", async () => {
		const host = makeHost({ ingestEvent: () => null });
		await withServer(host, async (send) => {
			const frame = await send("agent-event", {
				surfaceId: "pane-9",
				event: "PostToolUse",
			});
			expect(frame.result).toEqual({ applied: false, from: null, to: null });
		});
	});

	it("rejects a missing surfaceId with BAD_REQUEST", async () => {
		await withServer(makeHost({}), async (send) => {
			const frame = await send("agent-event", { event: "Stop" });
			expect(frame.ok).toBe(false);
			expect((frame.error as { code: string }).code).toBe("BAD_REQUEST");
		});
	});

	it("rejects a missing event name with BAD_REQUEST", async () => {
		await withServer(makeHost({}), async (send) => {
			const frame = await send("agent-event", { surfaceId: "p" });
			expect((frame.error as { code: string }).code).toBe("BAD_REQUEST");
		});
	});
});

describe.skipIf(IS_WIN)("hooks-setup / hooks-status", () => {
	it("defaults to claude and returns the write result", async () => {
		await withServer(makeHost({}), async (send) => {
			const frame = await send("hooks-setup");
			expect(frame.ok).toBe(true);
			expect(frame.result).toMatchObject({
				agent: "claude",
				changed: true,
				settingsPath: "/tmp/claude-settings.json",
			});
		});
	});

	it("surfaces the backup path when one was written", async () => {
		const host = makeHost({
			setupHooks: (agent) => ({
				agent,
				settingsPath: "/tmp/claude-settings.json",
				changed: true,
				backupPath: "/tmp/claude-settings.json.2026-08-09.bak",
				registered: ["Stop"],
				missing: [],
			}),
		});
		await withServer(host, async (send) => {
			const frame = await send("hooks-setup", { agent: "claude" });
			expect((frame.result as { backupPath: string }).backupPath).toBe(
				"/tmp/claude-settings.json.2026-08-09.bak",
			);
		});
	});

	it("answers UNSUPPORTED for codex and opencode, not BAD_REQUEST", async () => {
		await withServer(makeHost({}), async (send) => {
			for (const agent of ["codex", "opencode"]) {
				const frame = await send("hooks-setup", { agent });
				expect(frame.ok).toBe(false);
				expect((frame.error as { code: string }).code).toBe("UNSUPPORTED");
			}
		});
	});

	it("rejects an agent it has never heard of", async () => {
		await withServer(makeHost({}), async (send) => {
			const frame = await send("hooks-setup", { agent: "frobnicate" });
			expect((frame.error as { code: string }).code).toBe("BAD_REQUEST");
		});
	});

	it("reports coverage, including what is missing", async () => {
		await withServer(makeHost({}), async (send) => {
			const frame = await send("hooks-status");
			expect(frame.result).toMatchObject({
				agent: "claude",
				present: true,
				supported: true,
				registered: ["Stop"],
				missing: ["SessionEnd"],
			});
		});
	});

	it("reports unsupported agents as such instead of failing", async () => {
		await withServer(makeHost({}), async (send) => {
			const frame = await send("hooks-status", { agent: "codex" });
			expect(frame.ok).toBe(true);
			expect(frame.result).toMatchObject({ agent: "codex", supported: false });
		});
	});
});
