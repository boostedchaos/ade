import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlaneHost } from "../host";
import { NdjsonParser } from "../ndjson";
import { ControlPlaneServer } from "../server";
import type { ControlPlaneSnapshot } from "../snapshot";
import { phase1Commands } from "./index";
import { lastLines, stripAnsi, tryLiveScreenRead } from "./terminal";

const IS_WIN = process.platform === "win32";
const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("stripAnsi", () => {
	it("removes SGR colour sequences", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("removes cursor-movement sequences", () => {
		expect(stripAnsi("a\x1b[2Ab")).toBe("ab");
	});

	it("removes an OSC title terminated by BEL", () => {
		expect(stripAnsi("\x1b]0;my title\x07text")).toBe("text");
	});

	it("removes an OSC terminated by ST", () => {
		expect(stripAnsi("\x1b]7;file:///tmp\x1b\\text")).toBe("text");
	});

	it("leaves plain text untouched", () => {
		expect(stripAnsi("plain — text")).toBe("plain — text");
	});

	it("drops a CR that only precedes a LF", () => {
		expect(stripAnsi("one\r\ntwo")).toBe("one\ntwo");
	});
});

describe("lastLines", () => {
	it("returns the final n lines", () => {
		expect(lastLines("a\nb\nc\nd", 2)).toBe("c\nd");
	});

	it("returns everything when asked for more lines than exist", () => {
		expect(lastLines("a\nb", 10)).toBe("a\nb");
	});

	it("ignores trailing blank lines when counting", () => {
		expect(lastLines("a\nb\nc\n\n\n", 2)).toBe("b\nc");
	});

	it("handles an empty buffer", () => {
		expect(lastLines("", 5)).toBe("");
	});
});

const LIVE = {
	text: "rendered screen",
	cols: 100,
	rows: 30,
	scrollbackLines: 42,
	alternateScreen: false,
	cwd: "/tmp",
	isAlive: true,
	flushed: true,
};

describe("tryLiveScreenRead", () => {
	const noop = () => {};

	it("returns null when the host cannot do a live read", async () => {
		expect(await tryLiveScreenRead({}, "p1", {}, noop)).toBeNull();
	});

	it("returns the host's result when it can", async () => {
		const terminal = { readSnapshot: async () => LIVE };
		expect(await tryLiveScreenRead(terminal, "p1", {}, noop)).toEqual(LIVE);
	});

	it("returns null — not a throw — when the read fails", async () => {
		// An older daemon answers `snapshot` with an error. A screen read must
		// fall back to the transcript, never fail the command.
		const terminal = {
			readSnapshot: async () => {
				throw new Error("UNKNOWN_TYPE");
			},
		};
		expect(await tryLiveScreenRead(terminal, "p1", {}, noop)).toBeNull();
	});

	it("logs why it fell back, so a silent downgrade is visible", async () => {
		const messages: string[] = [];
		const terminal = {
			readSnapshot: async () => {
				throw new Error("daemon is gone");
			},
		};
		await tryLiveScreenRead(terminal, "p1", {}, (_level, message) => {
			messages.push(message);
		});
		expect(messages.join(" ")).toContain("daemon is gone");
	});

	it("passes the caller's options through", async () => {
		let seen: unknown;
		const terminal = {
			readSnapshot: async (_paneId: string, options: unknown) => {
				seen = options;
				return LIVE;
			},
		};
		await tryLiveScreenRead(
			terminal,
			"p1",
			{ includeScrollback: true, maxLines: 7 },
			noop,
		);
		expect(seen).toEqual({ includeScrollback: true, maxLines: 7 });
	});
});

// ---------------------------------------------------------------------------
// Source selection, over a real socket. Isolated in a mkdtemp dir — these can
// never reach the developer's running app.
// ---------------------------------------------------------------------------

function snapshotFixture(): ControlPlaneSnapshot {
	return {
		panes: {
			p1: { id: "p1", tabId: "t1", type: "terminal", name: "term" },
			web: { id: "web", tabId: "t1", type: "webview", name: "browser" },
		},
		tabs: [{ id: "t1", name: "tab", workspaceId: "ws1", createdAt: 1 }],
		activeTabIds: { ws1: "t1" },
		focusedPaneIds: { t1: "p1" },
		tabLayouts: { t1: { direction: "row", first: "p1", second: "web" } },
		focusedWorkspaceId: "ws1",
		workspaceOrder: ["ws1"],
	};
}

function makeHost(
	terminalOverrides: Partial<ControlPlaneHost["terminal"]> & {
		readSnapshot?: unknown;
	} = {},
): ControlPlaneHost {
	return {
		appVersion: "test",
		getSnapshot: snapshotFixture,
		listWorkspaces: () => [],
		resolveProjectId: () => null,
		dispatchToRenderer: async () => ({}),
		terminal: {
			write: () => {},
			getSession: () => null,
			readScrollback: async () => null,
			...terminalOverrides,
		} as ControlPlaneHost["terminal"],
		log: () => {},
	};
}

class Client {
	private readonly parser = new NdjsonParser<Record<string, unknown>>();
	private readonly frames: Record<string, unknown>[] = [];

	private constructor(private readonly socket: Socket) {
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const value of this.parser.parse(chunk).values)
				this.frames.push(value);
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
	const dir = mkdtempSync(join(tmpdir(), "ade-term-read-"));
	tempDirs.push(dir);
	const socketPath = join(dir, "control.sock");
	const tokenPath = join(dir, "control.token");
	const server = new ControlPlaneServer({
		socketPath,
		tokenPath,
		host,
		commands: phase1Commands,
	});
	await server.start();
	const token = readFileSync(tokenPath, "utf-8").trim();
	const client = await Client.connect(socketPath);
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

describe.skipIf(IS_WIN)("read-screen / capture-pane source selection", () => {
	it("uses the live screen and says so", async () => {
		const host = makeHost({ readSnapshot: async () => LIVE });
		await withServer(host, async (send) => {
			const frame = await send("read-screen", { pane: "p1" });
			expect(frame.ok).toBe(true);
			const result = frame.result as Record<string, unknown>;
			expect(result.source).toBe("live-screen");
			expect(result.text).toBe("rendered screen");
			expect(result.cols).toBe(100);
			expect(result.rows).toBe(30);
			expect(result.alternateScreen).toBe(false);
		});
	});

	it("asks the live read for scrollback and the caller's line cap", async () => {
		let seen: unknown;
		const host = makeHost({
			readSnapshot: async (_paneId: string, options: unknown) => {
				seen = options;
				return LIVE;
			},
		});
		await withServer(host, async (send) => {
			await send("read-screen", { pane: "p1", lines: 12 });
		});
		expect(seen).toEqual({ includeScrollback: true, maxLines: 12 });
	});

	it("falls back to history when there is no live read, and says so", async () => {
		const host = makeHost({
			readScrollback: async () => "\x1b[31mold\x1b[0m output\nsecond line\n",
		});
		await withServer(host, async (send) => {
			const frame = await send("read-screen", { pane: "p1" });
			const result = frame.result as Record<string, unknown>;
			expect(result.source).toBe("scrollback-history");
			expect(result.text).toBe("old output\nsecond line");
		});
	});

	it("falls back to history when the live read throws", async () => {
		const host = makeHost({
			readSnapshot: async () => {
				throw new Error("no live session");
			},
			readScrollback: async () => "history text\n",
		});
		await withServer(host, async (send) => {
			const frame = await send("read-screen", { pane: "p1" });
			const result = frame.result as Record<string, unknown>;
			expect(result.source).toBe("scrollback-history");
			expect(result.text).toBe("history text");
		});
	});

	it("is NOT_FOUND only when neither source has anything", async () => {
		await withServer(makeHost(), async (send) => {
			const frame = await send("read-screen", { pane: "p1" });
			expect(frame.ok).toBe(false);
			expect((frame.error as { code: string }).code).toBe("NOT_FOUND");
		});
	});

	it("capture-pane prefers the live screen and reports scrollbackLines", async () => {
		const host = makeHost({ readSnapshot: async () => LIVE });
		await withServer(host, async (send) => {
			const frame = await send("capture-pane", { pane: "p1" });
			const result = frame.result as Record<string, unknown>;
			expect(result.source).toBe("live-screen");
			expect(result.scrollbackLines).toBe(42);
		});
	});

	it("capture-pane asks for scrollback with no line cap", async () => {
		let seen: unknown;
		const host = makeHost({
			readSnapshot: async (_paneId: string, options: unknown) => {
				seen = options;
				return LIVE;
			},
		});
		await withServer(host, async (send) => {
			await send("capture-pane", { pane: "p1" });
		});
		expect(seen).toEqual({ includeScrollback: true });
	});

	it("capture-pane --raw goes to history, because only it carries escapes", async () => {
		let liveCalls = 0;
		const host = makeHost({
			readSnapshot: async () => {
				liveCalls += 1;
				return LIVE;
			},
			readScrollback: async () => "\x1b[31mraw\x1b[0m",
		});
		await withServer(host, async (send) => {
			const frame = await send("capture-pane", { pane: "p1", raw: true });
			const result = frame.result as Record<string, unknown>;
			expect(result.source).toBe("scrollback-history");
			expect(result.text).toBe("\x1b[31mraw\x1b[0m");
		});
		// The live read must not even be attempted — it cannot answer --raw.
		expect(liveCalls).toBe(0);
	});

	it("still refuses a non-terminal pane", async () => {
		const host = makeHost({ readSnapshot: async () => LIVE });
		await withServer(host, async (send) => {
			const frame = await send("read-screen", { pane: "web" });
			expect(frame.ok).toBe(false);
			expect((frame.error as { code: string }).code).toBe("BAD_REQUEST");
		});
	});
});
