import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BridgeOp,
	ControlPlaneHost,
	NotificationSnapshot,
	NotificationsHost,
} from "../host";
import { NdjsonParser } from "../ndjson";
import { ControlPlaneServer } from "../server";
import type { ControlPlaneSnapshot } from "../snapshot";
import { phase1Commands } from "./index";
import { nextUnreadPane } from "./notifications";

/**
 * Socket-isolated per the daemon test idiom: every server binds inside its own
 * mkdtemp, so a test run can never reach the live ~/.ade/control.sock.
 */
const tempDirs: string[] = [];
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Two panes in one tab, pane-1 focused. Enough to exercise target resolution
 * and the jump cursor without a renderer.
 */
const SNAPSHOT: ControlPlaneSnapshot = {
	panes: {
		"pane-1": { id: "pane-1", tabId: "tab-1", type: "terminal", name: "One" },
		"pane-2": { id: "pane-2", tabId: "tab-1", type: "terminal", name: "Two" },
	},
	tabs: [
		{
			id: "tab-1",
			name: "Tab",
			workspaceId: "ws-1",
			createdAt: 1,
		},
	],
	activeTabIds: { "ws-1": "tab-1" },
	focusedPaneIds: { "tab-1": "pane-1" },
	tabLayouts: { "tab-1": { first: "pane-1", second: "pane-2" } },
	focusedWorkspaceId: "ws-1",
	workspaceOrder: ["ws-1"],
};

function record(
	over: Partial<NotificationSnapshot> = {},
): NotificationSnapshot {
	return {
		id: "n1",
		kind: "attention",
		title: "One needs input",
		body: "waiting",
		paneId: "pane-1",
		workspaceId: "ws-1",
		createdAt: 1_700_000_000_000,
		readAt: null,
		...over,
	};
}

function makeHost(
	notifications?: Partial<NotificationsHost>,
	onDispatch?: (op: BridgeOp) => void,
): ControlPlaneHost {
	return {
		appVersion: "test",
		getSnapshot: () => SNAPSHOT,
		listWorkspaces: () => [],
		resolveProjectId: () => null,
		dispatchToRenderer: async (op) => {
			onDispatch?.(op);
			return { applied: ["setFocusedPane"] };
		},
		terminal: {
			write: () => {},
			getSession: () => null,
			readScrollback: async () => null,
		},
		notifications: notifications
			? ({
					list: () => [record()],
					create: (input) => record({ ...input, id: "created" }),
					markRead: () => true,
					markAllRead: () => 3,
					panesWithUnreadAttention: () => ["pane-1"],
					...notifications,
				} as NotificationsHost)
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
	const dir = mkdtempSync(join(tmpdir(), "ade-notifications-"));
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

describe("nextUnreadPane", () => {
	it("returns null when nothing is waiting", () => {
		expect(nextUnreadPane([], "pane-1")).toBeNull();
		expect(nextUnreadPane([], null)).toBeNull();
	});

	it("starts at the newest candidate when focus is elsewhere", () => {
		expect(nextUnreadPane(["a", "b"], "unrelated")).toBe("a");
		expect(nextUnreadPane(["a", "b"], null)).toBe("a");
	});

	it("advances past the focused candidate", () => {
		expect(nextUnreadPane(["a", "b", "c"], "a")).toBe("b");
		expect(nextUnreadPane(["a", "b", "c"], "b")).toBe("c");
	});

	it("wraps at the end", () => {
		expect(nextUnreadPane(["a", "b", "c"], "c")).toBe("a");
	});

	it("re-selects the only candidate rather than reporting nothing", () => {
		expect(nextUnreadPane(["a"], "a")).toBe("a");
	});
});

describe.skipIf(IS_WIN)("notify", () => {
	it("creates a custom notification and resolves --pane", async () => {
		let created: unknown;
		const host = makeHost({
			create: (input) => {
				created = input;
				return record({ id: "created", kind: "custom", title: input.title });
			},
		});
		await withServer(host, async (send) => {
			const frame = await send("notify", {
				title: "Build done",
				body: "all green",
				pane: "pane:2",
			});
			expect(frame.ok).toBe(true);
			expect(created).toMatchObject({
				kind: "custom",
				title: "Build done",
				body: "all green",
				// pane:2 is the second pane in LAYOUT order, not insertion order.
				paneId: "pane-2",
				workspaceId: "ws-1",
			});
		});
	});

	it("allows a notification with no pane at all", async () => {
		let created: { paneId?: unknown } | undefined;
		const host = makeHost({
			create: (input) => {
				created = input;
				return record({ id: "created", kind: "custom" });
			},
		});
		await withServer(host, async (send) => {
			const frame = await send("notify", { title: "Heads up" });
			expect(frame.ok).toBe(true);
			expect(created?.paneId).toBeNull();
		});
	});

	it("rejects a missing title with BAD_REQUEST", async () => {
		await withServer(makeHost({}), async (send) => {
			const frame = await send("notify", { body: "no title" });
			expect(frame.ok).toBe(false);
			expect((frame.error as { code: string }).code).toBe("BAD_REQUEST");
		});
	});

	it("answers UNSUPPORTED on a build with no notification store", async () => {
		await withServer(makeHost(), async (send) => {
			const frame = await send("notify", { title: "x" });
			expect(frame.ok).toBe(false);
			expect((frame.error as { code: string }).code).toBe("UNSUPPORTED");
		});
	});
});

describe.skipIf(IS_WIN)("list-notifications", () => {
	it("passes --unread through and reports the unread count", async () => {
		let sawUnreadOnly: boolean | undefined;
		const host = makeHost({
			list: (options) => {
				sawUnreadOnly = options.unreadOnly;
				return [record(), record({ id: "n2", readAt: 1 })];
			},
		});
		await withServer(host, async (send) => {
			const frame = await send("list-notifications", { unread: true });
			expect(frame.ok).toBe(true);
			expect(sawUnreadOnly).toBe(true);
			expect(frame.result).toMatchObject({ unread: 1 });
		});
	});

	it("defaults to every notification", async () => {
		let sawUnreadOnly: boolean | undefined;
		const host = makeHost({
			list: (options) => {
				sawUnreadOnly = options.unreadOnly;
				return [];
			},
		});
		await withServer(host, async (send) => {
			await send("list-notifications");
			expect(sawUnreadOnly).toBe(false);
		});
	});
});

describe.skipIf(IS_WIN)("mark-notification-read", () => {
	it("marks one by id", async () => {
		let seen: string | undefined;
		const host = makeHost({
			markRead: (id) => {
				seen = id;
				return true;
			},
		});
		await withServer(host, async (send) => {
			const frame = await send("mark-notification-read", { id: "n1" });
			expect(frame.ok).toBe(true);
			expect(seen).toBe("n1");
			expect(frame.result).toMatchObject({ marked: 1, all: false });
		});
	});

	it("reports 0 marked when the id was already read or unknown", async () => {
		await withServer(makeHost({ markRead: () => false }), async (send) => {
			const frame = await send("mark-notification-read", { id: "gone" });
			expect(frame.result).toMatchObject({ marked: 0 });
		});
	});

	it("marks all when --all is set, without needing an id", async () => {
		await withServer(makeHost({}), async (send) => {
			const frame = await send("mark-notification-read", { all: true });
			expect(frame.ok).toBe(true);
			expect(frame.result).toMatchObject({ marked: 3, all: true });
		});
	});

	it("requires an id when --all is absent", async () => {
		await withServer(makeHost({}), async (send) => {
			const frame = await send("mark-notification-read", {});
			expect(frame.ok).toBe(false);
			expect((frame.error as { code: string }).code).toBe("BAD_REQUEST");
		});
	});
});

describe.skipIf(IS_WIN)("jump-to-unread", () => {
	it("focuses the next waiting pane through the renderer bridge", async () => {
		const ops: BridgeOp[] = [];
		const host = makeHost(
			{ panesWithUnreadAttention: () => ["pane-2", "pane-1"] },
			(op) => ops.push(op),
		);
		await withServer(host, async (send) => {
			// pane-1 has focus and IS a candidate, so the cursor advances past it
			// and wraps to the newest.
			const frame = await send("jump-to-unread");
			expect(frame.ok).toBe(true);
			expect(frame.result).toMatchObject({ jumped: true, paneId: "pane-2" });
			expect(ops).toEqual([
				{
					kind: "focus-pane",
					paneId: "pane-2",
					tabId: "tab-1",
					workspaceId: "ws-1",
				},
			]);
		});
	});

	it("skips panes that no longer exist", async () => {
		const ops: BridgeOp[] = [];
		const host = makeHost(
			{ panesWithUnreadAttention: () => ["pane-gone", "pane-2"] },
			(op) => ops.push(op),
		);
		await withServer(host, async (send) => {
			const frame = await send("jump-to-unread");
			expect(frame.result).toMatchObject({ jumped: true, paneId: "pane-2" });
			expect(ops).toHaveLength(1);
		});
	});

	it("reports jumped:false and touches nothing when nothing is waiting", async () => {
		const ops: BridgeOp[] = [];
		const host = makeHost({ panesWithUnreadAttention: () => [] }, (op) =>
			ops.push(op),
		);
		await withServer(host, async (send) => {
			const frame = await send("jump-to-unread");
			expect(frame.ok).toBe(true);
			expect(frame.result).toMatchObject({ jumped: false, paneId: null });
			expect(ops).toHaveLength(0);
		});
	});
});
