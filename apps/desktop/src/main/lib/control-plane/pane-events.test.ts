/**
 * Pane lifecycle events, end to end over a real control socket.
 *
 * The gap this covers: `pane-created` / `pane-closed` / `pane-focused` were
 * declared in the protocol, advertised in `ade events --help` and asserted in
 * transport tests that emitted onto the bus BY HAND — and never produced by
 * anything in the app. A test that hand-feeds the bus proves the pipe, not the
 * producer, which is exactly why the gap survived. So this drives the real
 * producer (`publishPaneEvents`, the function `ui-state.tabs.set` calls) into a
 * real `ControlPlaneServer` and reads the frames off a real unix socket.
 *
 * Only Electron's `getControlPlaneEvents` accessor is stubbed, because the real
 * one owns app/BrowserWindow. The diff, the bus, the server, the NDJSON framing
 * and the socket are all the shipping code.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ControlPlaneHost,
	ControlPlaneServer,
	type ControlPlaneSnapshot,
	NdjsonParser,
	phase1Commands,
} from "../../../../../../packages/control-plane/src/index";
import type { TabsState } from "../app-state/schemas";

const IS_WIN = process.platform === "win32";

let bus: ControlPlaneServer["events"] | null = null;

mock.module("./index", () => ({
	getControlPlaneEvents: () => bus,
}));

const { diffPaneEvents, publishPaneEvents } = await import("./pane-events");

function mirror(
	panes: Record<string, { tabId: string; type: string }>,
	focusedPaneIds: Record<string, string> = {},
): TabsState {
	return {
		tabs: [],
		panes: Object.fromEntries(
			Object.entries(panes).map(([id, p]) => [
				id,
				{ id, name: id, tabId: p.tabId, type: p.type },
			]),
		),
		activeTabIds: {},
		focusedPaneIds,
		tabHistoryStacks: {},
	} as unknown as TabsState;
}

describe("diffPaneEvents", () => {
	it("reports a new pane as created", () => {
		expect(
			diffPaneEvents(
				mirror({ p1: { tabId: "t1", type: "terminal" } }),
				mirror({
					p1: { tabId: "t1", type: "terminal" },
					p2: { tabId: "t1", type: "terminal" },
				}),
			),
		).toEqual([
			{
				kind: "pane-created",
				data: { paneId: "p2", tabId: "t1", type: "terminal" },
			},
		]);
	});

	it("reports a vanished pane as closed", () => {
		expect(
			diffPaneEvents(
				mirror({
					p1: { tabId: "t1", type: "terminal" },
					p2: { tabId: "t1", type: "webview" },
				}),
				mirror({ p1: { tabId: "t1", type: "terminal" } }),
			),
		).toEqual([
			{
				kind: "pane-closed",
				data: { paneId: "p2", tabId: "t1", type: "webview" },
			},
		]);
	});

	it("reports a focus move, and only when it actually moves", () => {
		const panes = {
			p1: { tabId: "t1", type: "terminal" },
			p2: { tabId: "t1", type: "terminal" },
		};
		expect(
			diffPaneEvents(mirror(panes, { t1: "p1" }), mirror(panes, { t1: "p2" })),
		).toEqual([{ kind: "pane-focused", data: { paneId: "p2", tabId: "t1" } }]);
		expect(
			diffPaneEvents(mirror(panes, { t1: "p1" }), mirror(panes, { t1: "p1" })),
		).toEqual([]);
	});

	it("treats an absent previous mirror as empty without crashing", () => {
		expect(
			diffPaneEvents(
				undefined,
				mirror({ p1: { tabId: "t1", type: "terminal" } }),
			),
		).toEqual([
			{
				kind: "pane-created",
				data: { paneId: "p1", tabId: "t1", type: "terminal" },
			},
		]);
		expect(diffPaneEvents(undefined, undefined)).toEqual([]);
	});

	it("is silent when nothing about panes changed", () => {
		const same = mirror(
			{ p1: { tabId: "t1", type: "terminal" } },
			{ t1: "p1" },
		);
		expect(diffPaneEvents(same, same)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Socket level: real server, real bus, real client.
// ---------------------------------------------------------------------------

const EMPTY_SNAPSHOT: ControlPlaneSnapshot = {
	panes: {},
	tabs: [],
	activeTabIds: {},
	focusedPaneIds: {},
	tabLayouts: {},
	focusedWorkspaceId: null,
	workspaceOrder: [],
};

function makeHost(): ControlPlaneHost {
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
		} as ControlPlaneHost["terminal"],
		log: () => {},
	};
}

describe.skipIf(IS_WIN)("pane events over the control socket", () => {
	let dir: string;
	let server: ControlPlaneServer;
	let socket: Socket | null = null;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ade-pane-events-"));
	});

	afterEach(async () => {
		socket?.destroy();
		socket = null;
		bus = null;
		await server?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("a subscribed client receives the events a layout change produces", async () => {
		server = new ControlPlaneServer({
			socketPath: join(dir, "sock"),
			tokenPath: join(dir, "token"),
			host: makeHost(),
			commands: phase1Commands,
		});
		await server.start();
		bus = server.events;

		const frames: Record<string, unknown>[] = [];
		const parser = new NdjsonParser<Record<string, unknown>>();
		socket = await new Promise<Socket>((resolve, reject) => {
			const s = createConnection(join(dir, "sock"));
			s.once("error", reject);
			s.once("connect", () => resolve(s));
		});
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const value of parser.parse(chunk).values) frames.push(value);
		});

		socket.write(
			`${JSON.stringify({ id: "1", cmd: "hello", token: server.currentToken })}\n`,
		);
		socket.write(`${JSON.stringify({ id: "2", cmd: "subscribe" })}\n`);

		const waitFor = async (count: number) => {
			const deadline = Date.now() + 3000;
			while (frames.length < count && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 5));
			}
		};
		await waitFor(2);
		expect(frames[1]).toMatchObject({ id: "2", ok: true });

		// The production call, in the order ui-state.tabs.set makes it: split a
		// pane off p1 and focus it, then close p1.
		const before = mirror(
			{ p1: { tabId: "t1", type: "terminal" } },
			{ t1: "p1" },
		);
		const after = mirror(
			{
				p1: { tabId: "t1", type: "terminal" },
				p2: { tabId: "t1", type: "terminal" },
			},
			{ t1: "p2" },
		);
		publishPaneEvents(before, after);
		publishPaneEvents(
			after,
			mirror({ p2: { tabId: "t1", type: "terminal" } }, { t1: "p2" }),
		);

		await waitFor(5);
		const events = frames.slice(2);
		expect(events.map((f) => f.event)).toEqual([
			"pane-created",
			"pane-focused",
			"pane-closed",
		]);
		expect(events[0]?.data).toEqual({
			paneId: "p2",
			tabId: "t1",
			type: "terminal",
		});
		expect(events[2]?.data).toEqual({
			paneId: "p1",
			tabId: "t1",
			type: "terminal",
		});
	});

	it("publishing with no control plane running is a no-op, not a throw", () => {
		bus = null;
		expect(() =>
			publishPaneEvents(
				undefined,
				mirror({ p1: { tabId: "t1", type: "terminal" } }),
			),
		).not.toThrow();
	});
});
