import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentSessionsHost,
	BridgeOp,
	BrowserPaneHost,
	ControlPlaneHost,
	TodoSnapshot,
	TodosHost,
} from "../host";
import { NdjsonParser } from "../ndjson";
import { ControlPlaneServer } from "../server";
import type { ControlPlaneSnapshot } from "../snapshot";
import { clickScript, jsLiteral, parseFillFields, typeScript } from "./browser";
import { phase1Commands } from "./index";
import { parseProgressValue } from "./status";

/**
 * Phase 5 (parity extras) command tests: todos, browser scripting, status.
 *
 * Socket-isolated per the daemon test idiom — every server binds inside its own
 * mkdtemp, so a run can never reach the live ~/.ade/control.sock.
 */

const tempDirs: string[] = [];
afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A terminal pane and a browser pane in one tab; the terminal is focused. */
const SNAPSHOT: ControlPlaneSnapshot = {
	panes: {
		"pane-1": { id: "pane-1", tabId: "tab-1", type: "terminal", name: "One" },
		"pane-2": {
			id: "pane-2",
			tabId: "tab-1",
			type: "webview",
			name: "Browser",
			url: "https://example.com",
		},
	},
	tabs: [{ id: "tab-1", name: "Tab", workspaceId: "ws-1", createdAt: 1 }],
	activeTabIds: { "ws-1": "tab-1" },
	focusedPaneIds: { "tab-1": "pane-1" },
	tabLayouts: { "tab-1": { first: "pane-1", second: "pane-2" } },
	focusedWorkspaceId: "ws-1",
	workspaceOrder: ["ws-1"],
};

function todo(over: Partial<TodoSnapshot> = {}): TodoSnapshot {
	return {
		id: "t1",
		workspaceId: "ws-1",
		title: "Do the thing",
		state: "pending",
		sortOrder: 1,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		completedAt: null,
		...over,
	};
}

interface HostParts {
	todos?: Partial<TodosHost> | false;
	browser?: Partial<BrowserPaneHost> | false;
	agents?: Partial<AgentSessionsHost> | false;
	onDispatch?: (op: BridgeOp) => void;
	onEvaluate?: (paneId: string, code: string) => void;
}

function makeHost(parts: HostParts = {}): ControlPlaneHost {
	return {
		appVersion: "test",
		getSnapshot: () => SNAPSHOT,
		listWorkspaces: () => [],
		resolveProjectId: () => null,
		dispatchToRenderer: async (op) => {
			parts.onDispatch?.(op);
			return { applied: ["splitPaneWithType"], paneId: "pane-new" };
		},
		terminal: {
			write: () => {},
			getSession: () => null,
			readScrollback: async () => null,
		},
		todos:
			parts.todos === false
				? undefined
				: ({
						list: () => [todo(), todo({ id: "t2", state: "completed" })],
						create: (input) => todo({ ...input, id: "created" }),
						setState: (id, state) => todo({ id, state }),
						remove: () => true,
						...parts.todos,
					} as TodosHost),
		browser:
			parts.browser === false
				? undefined
				: ({
						isAttached: () => true,
						navigate: async () => {},
						evaluate: async (paneId, code) => {
							parts.onEvaluate?.(paneId, code);
							return { clicked: true };
						},
						screenshot: async () => ({ path: "/tmp/shot.png" }),
						pageInfo: () => ({
							url: "https://example.com",
							title: "Example",
							isLoading: false,
						}),
						...parts.browser,
					} as BrowserPaneHost),
		agents:
			parts.agents === false
				? undefined
				: ({
						listSessions: () => [],
						ingestEvent: () => null,
						setState: () => ({ from: "idle", to: "needsInput" }),
						setProgress: () => true,
						setupHooks: () => {
							throw new Error("unused");
						},
						hooksStatus: () => {
							throw new Error("unused");
						},
						...parts.agents,
					} as AgentSessionsHost),
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
	const dir = mkdtempSync(join(tmpdir(), "ade-parity-"));
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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("jsLiteral", () => {
	it("escapes quotes and backslashes", () => {
		expect(jsLiteral('a"b\\c')).toBe('"a\\"b\\\\c"');
	});

	it("neutralises a script-closing sequence", () => {
		// The point of the extra `<` replacement: the emitted literal must not be
		// able to end an inline script block.
		expect(jsLiteral("</script>")).not.toContain("</script>");
		expect(jsLiteral("</script>")).toBe('"\\u003c/script>"');
	});

	it("escapes the JS line terminators JSON leaves raw", () => {
		expect(jsLiteral("a\u2028b")).toBe('"a\\u2028b"');
		expect(jsLiteral("a\u2029b")).toBe('"a\\u2029b"');
	});

	it("round-trips through a JS evaluator", () => {
		const nasty = 'he said "hi"\\n\u2028</script>';
		// eslint-disable-next-line no-new-func
		expect(new Function(`return ${jsLiteral(nasty)}`)()).toBe(nasty);
	});
});

describe("element scripts", () => {
	it("names the selector in the not-found error", () => {
		expect(clickScript("#go")).toContain(
			'throw new Error("No element matches selector " + "#go")',
		);
	});

	it("cannot be escaped by a selector containing a quote", () => {
		const script = clickScript('a[href="x"]');
		expect(script).toContain('"a[href=\\"x\\"]"');
	});

	it("dispatches input AND change so a controlled input updates", () => {
		const script = typeScript("#email", "a@b.c");
		expect(script).toContain('new Event("input", { bubbles: true })');
		expect(script).toContain('new Event("change", { bubbles: true })');
		// The native setter is what makes React see the value at all.
		expect(script).toContain("getOwnPropertyDescriptor");
	});
});

describe("parseFillFields", () => {
	it("accepts an object of selector → text", () => {
		expect(parseFillFields({ "#a": "1", "#b": "" })).toEqual([
			["#a", "1"],
			["#b", ""],
		]);
	});

	it("rejects a non-object, an array and an empty object", () => {
		expect(() => parseFillFields("nope")).toThrow();
		expect(() => parseFillFields([["#a", "1"]])).toThrow();
		expect(() => parseFillFields({})).toThrow();
	});

	it("rejects a non-string value rather than coercing it", () => {
		expect(() => parseFillFields({ "#qty": 3 })).toThrow();
		expect(() => parseFillFields({ "#qty": null })).toThrow();
	});
});

describe("parseProgressValue", () => {
	it("accepts 0 and 100 and everything between", () => {
		expect(parseProgressValue(0)).toBe(0);
		expect(parseProgressValue("42")).toBe(42);
		expect(parseProgressValue(100)).toBe(100);
	});

	it('treats "clear" as null', () => {
		expect(parseProgressValue("clear")).toBeNull();
		expect(parseProgressValue(null)).toBeNull();
	});

	it("rejects out-of-range, fractional and non-numeric values", () => {
		expect(() => parseProgressValue(-1)).toThrow();
		expect(() => parseProgressValue(101)).toThrow();
		expect(() => parseProgressValue(1.5)).toThrow();
		expect(() => parseProgressValue("soon")).toThrow();
		// An absent value must NOT silently clear the bar.
		expect(() => parseProgressValue(undefined)).toThrow();
	});
});

// ---------------------------------------------------------------------------
// Over the wire
// ---------------------------------------------------------------------------

describe.skipIf(IS_WIN)("todo commands", () => {
	it("adds against a resolved workspace ref", async () => {
		let seen: { workspaceId: string; title: string } | null = null;
		const host = makeHost({
			todos: {
				create: (input) => {
					seen = input;
					return todo({ ...input, id: "created" });
				},
			},
		});
		await withServer(host, async (send) => {
			const res = await send("todo-add", {
				workspace: "focused",
				title: "Write it down",
			});
			expect(res.ok).toBe(true);
			expect(seen).toEqual({ workspaceId: "ws-1", title: "Write it down" });
		});
	});

	it("lists with per-state counts", async () => {
		await withServer(makeHost(), async (send) => {
			const res = await send("todo-list", { workspace: "ws-1" });
			const result = res.result as {
				workspaceId: string;
				counts: Record<string, number>;
			};
			expect(result.workspaceId).toBe("ws-1");
			expect(result.counts).toEqual({
				pending: 1,
				"in-progress": 0,
				completed: 1,
			});
		});
	});

	it("rejects an unknown --state instead of matching nothing", async () => {
		await withServer(makeHost(), async (send) => {
			const res = await send("todo-list", {
				workspace: "ws-1",
				state: "blocked",
			});
			expect(res.ok).toBe(false);
			expect((res.error as { code: string }).code).toBe("BAD_REQUEST");
		});
	});

	it("start and done set the right states", async () => {
		await withServer(makeHost(), async (send) => {
			const started = await send("todo-start", { id: "t1" });
			expect((started.result as TodoSnapshot).state).toBe("in-progress");
			const done = await send("todo-done", { id: "t1" });
			expect((done.result as TodoSnapshot).state).toBe("completed");
		});
	});

	it("answers NOT_FOUND for a missing id on transition and remove", async () => {
		const host = makeHost({
			todos: { setState: () => null, remove: () => false },
		});
		await withServer(host, async (send) => {
			const started = await send("todo-start", { id: "nope" });
			expect((started.error as { code: string }).code).toBe("NOT_FOUND");
			const removed = await send("todo-rm", { id: "nope" });
			expect((removed.error as { code: string }).code).toBe("NOT_FOUND");
		});
	});

	it("answers UNSUPPORTED when the host does not track todos", async () => {
		await withServer(makeHost({ todos: false }), async (send) => {
			const res = await send("todo-list", { workspace: "ws-1" });
			expect((res.error as { code: string }).code).toBe("UNSUPPORTED");
		});
	});
});

describe.skipIf(IS_WIN)("browser commands", () => {
	it("opens as a SPLIT of the source pane, not a new tab", async () => {
		let op: BridgeOp | null = null;
		const host = makeHost({ onDispatch: (o) => (op = o) });
		await withServer(host, async (send) => {
			const res = await send("browser-open", {
				url: "https://example.com",
				direction: "right",
				focus: false,
			});
			expect(res.ok).toBe(true);
		});
		expect(op).toMatchObject({
			kind: "new-pane",
			paneType: "browser",
			sourcePaneId: "pane-1",
			direction: "right",
			focus: false,
			url: "https://example.com",
		});
	});

	it("refuses to script a terminal pane", async () => {
		await withServer(makeHost(), async (send) => {
			const res = await send("browser-click", {
				pane: "pane-1",
				selector: "#go",
			});
			expect((res.error as { code: string }).code).toBe("BAD_REQUEST");
			expect((res.error as { message: string }).message).toContain(
				"not a browser pane",
			);
		});
	});

	it("distinguishes a detached webview (NOT_FOUND) from a wrong pane type", async () => {
		const host = makeHost({ browser: { isAttached: () => false } });
		await withServer(host, async (send) => {
			const res = await send("browser-click", {
				pane: "pane-2",
				selector: "#go",
			});
			expect((res.error as { code: string }).code).toBe("NOT_FOUND");
		});
	});

	it("sends the built script to the named pane only", async () => {
		const calls: Array<{ paneId: string; code: string }> = [];
		const host = makeHost({
			onEvaluate: (paneId, code) => calls.push({ paneId, code }),
		});
		await withServer(host, async (send) => {
			await send("browser-click", { pane: "pane-2", selector: "#go" });
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.paneId).toBe("pane-2");
		expect(calls[0]?.code).toContain("el.click()");
	});

	it("accepts an empty --text as a deliberate clear", async () => {
		const codes: string[] = [];
		const host = makeHost({ onEvaluate: (_p, code) => codes.push(code) });
		await withServer(host, async (send) => {
			const res = await send("browser-type", {
				pane: "pane-2",
				selector: "#email",
				text: "",
			});
			expect(res.ok).toBe(true);
		});
		expect(codes[0]).toContain('setter.call(el, "")');
	});

	it("stops at the first failing field and reports how many were filled", async () => {
		let seen = 0;
		const host = makeHost({
			browser: {
				evaluate: async (_paneId, code) => {
					seen += 1;
					if (code.includes("#missing")) throw new Error("No element matches");
					return { filled: true };
				},
			},
		});
		await withServer(host, async (send) => {
			const res = await send("browser-fill", {
				pane: "pane-2",
				fields: { "#a": "1", "#missing": "2", "#c": "3" },
			});
			expect(res.ok).toBe(false);
			expect((res.error as { message: string }).message).toContain(
				"Filled 1 of 3 fields",
			);
		});
		// Third field never attempted — a half-filled form must not keep going.
		expect(seen).toBe(2);
	});

	it("returns the screenshot PATH, never image bytes", async () => {
		await withServer(makeHost(), async (send) => {
			const res = await send("browser-screenshot", { pane: "pane-2" });
			expect(res.result).toEqual({ paneId: "pane-2", path: "/tmp/shot.png" });
		});
	});

	it("declares what it does not support", async () => {
		await withServer(makeHost(), async (send) => {
			const res = await send("browser-capabilities");
			const result = res.result as {
				available: boolean;
				unsupported: string[];
			};
			expect(result.available).toBe(true);
			expect(result.unsupported.join(" ")).toContain("cdp");
			expect(result.unsupported.join(" ")).toContain("cookie");
		});
	});
});

describe.skipIf(IS_WIN)("status commands", () => {
	it("routes set-status into the session host with the pane's workspace", async () => {
		let seen: unknown = null;
		const host = makeHost({
			agents: {
				setState: (input) => {
					seen = input;
					return { from: "idle", to: "needsInput" };
				},
			},
		});
		await withServer(host, async (send) => {
			const res = await send("set-status", {
				pane: "pane-1",
				state: "needsInput",
			});
			expect(res.ok).toBe(true);
			expect((res.result as { to: string }).to).toBe("needsInput");
		});
		expect(seen).toEqual({
			surfaceId: "pane-1",
			state: "needsInput",
			workspaceId: "ws-1",
		});
	});

	it("rejects a state outside the three reportable ones", async () => {
		await withServer(makeHost(), async (send) => {
			// `ended` is real in the registry but is owned by the PTY exiting, not
			// by an agent claiming it.
			const res = await send("set-status", { pane: "pane-1", state: "ended" });
			expect((res.error as { code: string }).code).toBe("BAD_REQUEST");
		});
	});

	it("refuses to set status on a non-terminal pane", async () => {
		await withServer(makeHost(), async (send) => {
			const res = await send("set-status", {
				pane: "pane-2",
				state: "working",
			});
			expect((res.error as { code: string }).code).toBe("BAD_REQUEST");
		});
	});

	it("requires --pane rather than defaulting to focused", async () => {
		await withServer(makeHost(), async (send) => {
			const res = await send("set-status", { state: "working" });
			expect((res.error as { code: string }).code).toBe("BAD_REQUEST");
		});
	});

	it("set-progress passes the parsed value through", async () => {
		const seen: Array<number | null> = [];
		const host = makeHost({
			agents: {
				setProgress: (_id, value) => {
					seen.push(value);
					return true;
				},
			},
		});
		await withServer(host, async (send) => {
			await send("set-progress", { pane: "pane-1", value: 60 });
			await send("set-progress", { pane: "pane-1", value: "clear" });
		});
		expect(seen).toEqual([60, null]);
	});

	it("answers NOT_FOUND when the pane has no agent session", async () => {
		const host = makeHost({ agents: { setProgress: () => false } });
		await withServer(host, async (send) => {
			const res = await send("set-progress", { pane: "pane-1", value: 10 });
			expect((res.error as { code: string }).code).toBe("NOT_FOUND");
		});
	});
});
