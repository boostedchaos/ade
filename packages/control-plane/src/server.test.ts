import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlEventBus } from "./event-bus";
import type { ControlPlaneHost } from "./host";
import { NdjsonParser } from "./ndjson";
import { ControlPlaneServer } from "./server";
import type { ControlPlaneSnapshot } from "./snapshot";

/**
 * ISOLATION: these tests bind a socket inside a fresh mkdtemp directory, so
 * they can never reach the developer's running app. The daemon test idiom
 * (`SUPERSET_WORKSPACE_NAME` prefix) achieves the same thing by relocating
 * ~/.ade; here the paths are injected outright, which is stricter — there is
 * no code path by which these tests could resolve the real ~/.ade/control.sock.
 */
const IS_WIN = process.platform === "win32";

const tempDirs: string[] = [];
/**
 * Every TestClient ever connected. A client socket left open keeps bun's event
 * loop alive and the whole run hangs with no output — which looks exactly like
 * a wedged server rather than a leaked test fixture. Closing them centrally
 * means a test can never cause that by forgetting.
 */
const openClients: TestClient[] = [];

afterEach(() => {
	while (openClients.length > 0) {
		openClients.pop()?.destroy();
	}
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ade-cp-test-"));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function emptySnapshot(): ControlPlaneSnapshot {
	return {
		panes: { p1: { id: "p1", tabId: "t1", type: "terminal", name: "one" } },
		tabs: [{ id: "t1", name: "tab", workspaceId: "ws1", createdAt: 1 }],
		activeTabIds: { ws1: "t1" },
		focusedPaneIds: { t1: "p1" },
		tabLayouts: { t1: "p1" },
		focusedWorkspaceId: "ws1",
		workspaceOrder: ["ws1"],
	};
}

function makeHost(): ControlPlaneHost {
	return {
		appVersion: "0.4.0-test",
		getSnapshot: () => emptySnapshot(),
		listWorkspaces: () => [
			{
				id: "ws1",
				name: "Workspace One",
				projectId: "proj",
				type: "worktree",
				path: "/tmp/ws1",
				branch: "main",
			},
		],
		resolveProjectId: () => "proj",
		dispatchToRenderer: async () => ({ dispatched: true }),
		terminal: {
			write: () => {},
			getSession: () => null,
			readScrollback: async () => null,
		},
		log: () => {},
	};
}

/**
 * Indexed frame access. `noUncheckedIndexedAccess` makes every frames[i] an
 * optional, and a silent `undefined` in an assertion would make a missing
 * frame look like a passing test.
 */
function frameAt(
	frames: Record<string, unknown>[],
	index: number,
): Record<string, unknown> {
	const frame = frames[index];
	if (!frame) {
		throw new Error(
			`Expected a frame at index ${index}, got ${frames.length} frame(s)`,
		);
	}
	return frame;
}

function errorCodeOf(frame: Record<string, unknown>): string {
	const error = frame.error as { code?: string } | undefined;
	if (!error?.code) {
		throw new Error(`Expected an error frame, got ${JSON.stringify(frame)}`);
	}
	return error.code;
}

/** A test client that collects NDJSON frames off one connection. */
class TestClient {
	private readonly parser = new NdjsonParser<Record<string, unknown>>();
	private readonly frames: Record<string, unknown>[] = [];
	private waiters: Array<() => void> = [];
	closed = false;

	private constructor(private readonly socket: Socket) {
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const value of this.parser.parse(chunk).values) {
				this.frames.push(value);
			}
			const waiters = this.waiters;
			this.waiters = [];
			for (const w of waiters) w();
		});
		socket.on("close", () => {
			this.closed = true;
			const waiters = this.waiters;
			this.waiters = [];
			for (const w of waiters) w();
		});
	}

	static connect(path: string): Promise<TestClient> {
		return new Promise((resolve, reject) => {
			const socket = createConnection(path);
			socket.once("error", reject);
			socket.once("connect", () => {
				socket.off("error", reject);
				const client = new TestClient(socket);
				openClients.push(client);
				resolve(client);
			});
		});
	}

	sendRaw(text: string): void {
		this.socket.write(text);
	}

	send(value: unknown): void {
		this.socket.write(`${JSON.stringify(value)}\n`);
	}

	/** Resolves once at least `count` frames have arrived, or the peer closed. */
	async waitForFrames(
		count: number,
		timeoutMs = 2000,
	): Promise<Record<string, unknown>[]> {
		const deadline = Date.now() + timeoutMs;
		while (this.frames.length < count && !this.closed) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.min(remaining, 50));
				this.waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		return this.frames;
	}

	async waitForClose(timeoutMs = 2000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (!this.closed && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		return this.closed;
	}

	destroy(): void {
		this.socket.destroy();
	}
}

describe.skipIf(IS_WIN)("ControlPlaneServer — auth", () => {
	let server: ControlPlaneServer;
	let socketPath: string;
	let tokenPath: string;
	let token: string;

	beforeEach(async () => {
		const dir = makeTempDir();
		socketPath = join(dir, "control.sock");
		tokenPath = join(dir, "control.token");
		server = new ControlPlaneServer({
			socketPath,
			tokenPath,
			host: makeHost(),
			commands: {
				ping: () => ({ pong: true }),
			},
		});
		await server.start();
		token = readFileSync(tokenPath, "utf-8").trim();
	});

	afterEach(async () => {
		await server.stop();
	});

	it("writes a 0600 token file with 64 hex chars", () => {
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
	});

	it("regenerates the token on every start, unlike the daemon's reuse", async () => {
		const first = token;
		await server.stop();
		await server.start();
		const second = readFileSync(tokenPath, "utf-8").trim();
		expect(second).not.toBe(first);
	});

	it("chmods the socket to 0600", () => {
		expect(statSync(socketPath).mode & 0o777).toBe(0o600);
	});

	it("accepts a correct hello and reports the protocol version", async () => {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "1", cmd: "hello", token, client: "test/1" });
		const frame = frameAt(await client.waitForFrames(1), 0);
		expect(frame).toEqual({
			id: "1",
			ok: true,
			result: { protocol: 1, app: "0.4.0-test" },
		});
		client.destroy();
	});

	it("rejects a wrong token with AUTH_FAILED and closes", async () => {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "1", cmd: "hello", token: "f".repeat(64) });
		const frame = frameAt(await client.waitForFrames(1), 0);
		expect(frame.ok).toBe(false);
		expect(errorCodeOf(frame)).toBe("AUTH_FAILED");
		expect(await client.waitForClose()).toBe(true);
	});

	it("rejects a missing token with AUTH_FAILED", async () => {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "1", cmd: "hello" });
		const frame = frameAt(await client.waitForFrames(1), 0);
		expect(errorCodeOf(frame)).toBe("AUTH_FAILED");
	});

	it("rejects a token of a different length without throwing", async () => {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "1", cmd: "hello", token: "short" });
		const frame = frameAt(await client.waitForFrames(1), 0);
		expect(errorCodeOf(frame)).toBe("AUTH_FAILED");
	});

	it("rejects a non-hello first message with AUTH_REQUIRED and closes", async () => {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "1", cmd: "list-panes" });
		const frame = frameAt(await client.waitForFrames(1), 0);
		expect(errorCodeOf(frame)).toBe("AUTH_REQUIRED");
		expect(await client.waitForClose()).toBe(true);
	});

	it("does not run a registered command before hello", async () => {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "1", cmd: "ping" });
		const frame = frameAt(await client.waitForFrames(1), 0);
		expect(frame.ok).toBe(false);
		expect(errorCodeOf(frame)).toBe("AUTH_REQUIRED");
	});

	it("closes on a malformed first line instead of waiting for a retry", async () => {
		const client = await TestClient.connect(socketPath);
		client.sendRaw("this is not json\n");
		const frame = frameAt(await client.waitForFrames(1), 0);
		expect(errorCodeOf(frame)).toBe("BAD_REQUEST");
		expect(await client.waitForClose()).toBe(true);
	});

	it("rejects a second hello on an authenticated connection", async () => {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "1", cmd: "hello", token });
		client.send({ id: "2", cmd: "hello", token });
		const frames = await client.waitForFrames(2);
		expect(errorCodeOf(frameAt(frames, 1))).toBe("BAD_REQUEST");
	});
});

describe.skipIf(IS_WIN)("ControlPlaneServer — dispatch and framing", () => {
	let server: ControlPlaneServer;
	let socketPath: string;
	let token: string;

	beforeEach(async () => {
		const dir = makeTempDir();
		socketPath = join(dir, "control.sock");
		const tokenPath = join(dir, "control.token");
		server = new ControlPlaneServer({
			socketPath,
			tokenPath,
			host: makeHost(),
			commands: {
				echo: (_session, args) => ({ echoed: args.value }),
				boom: () => {
					throw new Error("handler exploded");
				},
			},
		});
		await server.start();
		token = readFileSync(tokenPath, "utf-8").trim();
	});

	afterEach(async () => {
		await server.stop();
	});

	async function authed(): Promise<TestClient> {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "hello", cmd: "hello", token });
		await client.waitForFrames(1);
		return client;
	}

	it("echoes the request id verbatim", async () => {
		const client = await authed();
		client.send({ id: "not-a-number", cmd: "echo", args: { value: 7 } });
		const frames = await client.waitForFrames(2);
		expect(frameAt(frames, 1)).toEqual({
			id: "not-a-number",
			ok: true,
			result: { echoed: 7 },
		});
	});

	it("answers pipelined requests, one response per request", async () => {
		const client = await authed();
		client.sendRaw(
			`${JSON.stringify({ id: "a", cmd: "echo", args: { value: 1 } })}\n` +
				`${JSON.stringify({ id: "b", cmd: "echo", args: { value: 2 } })}\n` +
				`${JSON.stringify({ id: "c", cmd: "echo", args: { value: 3 } })}\n`,
		);
		const frames = await client.waitForFrames(4);
		expect(frames.slice(1).map((f) => f.id)).toEqual(["a", "b", "c"]);
	});

	it("handles a request split across two writes", async () => {
		const client = await authed();
		client.sendRaw('{"id":"split","cmd":"ec');
		await new Promise((resolve) => setTimeout(resolve, 20));
		client.sendRaw('ho","args":{"value":"ok"}}\n');
		const frames = await client.waitForFrames(2);
		expect(frameAt(frames, 1)).toEqual({
			id: "split",
			ok: true,
			result: { echoed: "ok" },
		});
	});

	it("turns an unknown command into BAD_REQUEST without closing", async () => {
		const client = await authed();
		client.send({ id: "1", cmd: "no-such-command" });
		client.send({ id: "2", cmd: "echo", args: { value: "still here" } });
		const frames = await client.waitForFrames(3);
		expect(errorCodeOf(frameAt(frames, 1))).toBe("BAD_REQUEST");
		expect(frameAt(frames, 2).ok).toBe(true);
	});

	it("turns a thrown Error into INTERNAL", async () => {
		const client = await authed();
		client.send({ id: "1", cmd: "boom" });
		const frames = await client.waitForFrames(2);
		expect(errorCodeOf(frameAt(frames, 1))).toBe("INTERNAL");
	});

	it("serves list-panes from the host snapshot with no renderer dispatch", async () => {
		const dir = makeTempDir();
		const host = makeHost();
		let dispatched = 0;
		host.dispatchToRenderer = async () => {
			dispatched += 1;
			return {};
		};
		const { phase1Commands } = await import("./commands");
		const s = new ControlPlaneServer({
			socketPath: join(dir, "control.sock"),
			tokenPath: join(dir, "control.token"),
			host,
			commands: phase1Commands,
		});
		await s.start();
		const tok = readFileSync(join(dir, "control.token"), "utf-8").trim();
		const client = await TestClient.connect(join(dir, "control.sock"));
		client.send({ id: "h", cmd: "hello", token: tok });
		client.send({ id: "1", cmd: "list-panes" });
		const frames = await client.waitForFrames(2);
		expect(frameAt(frames, 1).ok).toBe(true);
		expect(dispatched).toBe(0);
		await s.stop();
	});
});

describe.skipIf(IS_WIN)("ControlPlaneServer — subscribe", () => {
	let server: ControlPlaneServer;
	let socketPath: string;
	let token: string;
	let bus: ControlEventBus;

	beforeEach(async () => {
		const dir = makeTempDir();
		socketPath = join(dir, "control.sock");
		bus = new ControlEventBus();
		server = new ControlPlaneServer({
			socketPath,
			tokenPath: join(dir, "control.token"),
			host: makeHost(),
			commands: { echo: () => ({}) },
			events: bus,
		});
		await server.start();
		token = readFileSync(join(dir, "control.token"), "utf-8").trim();
	});

	afterEach(async () => {
		await server.stop();
	});

	it("acks then streams matching events", async () => {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "h", cmd: "hello", token });
		client.send({ id: "s", cmd: "subscribe", args: { kinds: ["*"] } });
		await client.waitForFrames(2);

		bus.emit("pane-created", { paneId: "p1" });
		const frames = await client.waitForFrames(3);
		expect(frameAt(frames, 1)).toEqual({
			id: "s",
			ok: true,
			result: { subscribed: true },
		});
		expect(frameAt(frames, 2).event).toBe("pane-created");
		expect(frameAt(frames, 2).data).toEqual({ paneId: "p1" });
		expect(typeof frameAt(frames, 2).ts).toBe("string");
	});

	it("filters to the requested kinds", async () => {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "h", cmd: "hello", token });
		client.send({
			id: "s",
			cmd: "subscribe",
			args: { kinds: ["pane-closed"] },
		});
		await client.waitForFrames(2);

		bus.emit("pane-created", { paneId: "ignored" });
		bus.emit("pane-closed", { paneId: "wanted" });
		const frames = await client.waitForFrames(3);
		expect(frames.length).toBe(3);
		expect(frameAt(frames, 2).event).toBe("pane-closed");
	});

	it("accepts a kind it does not know without failing the subscribe", async () => {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "h", cmd: "hello", token });
		client.send({
			id: "s",
			cmd: "subscribe",
			args: { kinds: ["pane-created", "from-a-future-version"] },
		});
		const frames = await client.waitForFrames(2);
		expect(frameAt(frames, 1).ok).toBe(true);
	});

	it("refuses further requests once streaming", async () => {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "h", cmd: "hello", token });
		client.send({ id: "s", cmd: "subscribe", args: { kinds: ["*"] } });
		await client.waitForFrames(2);
		client.send({ id: "x", cmd: "echo" });
		const frames = await client.waitForFrames(3);
		expect(errorCodeOf(frameAt(frames, 2))).toBe("BAD_REQUEST");
	});

	it("drops the subscription when the connection closes", async () => {
		const client = await TestClient.connect(socketPath);
		client.send({ id: "h", cmd: "hello", token });
		client.send({ id: "s", cmd: "subscribe", args: { kinds: ["*"] } });
		await client.waitForFrames(2);
		expect(bus.subscriberCount).toBe(1);
		client.destroy();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(bus.subscriberCount).toBe(0);
	});
});
