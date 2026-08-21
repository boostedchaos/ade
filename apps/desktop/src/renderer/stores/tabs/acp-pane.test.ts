/**
 * The store-side of the ACP pane: the factory, the persisted version boundary,
 * and the cleanup sweep.
 *
 * The sweep test DOES mount the store (unlike the pure-function convention the
 * other tabs tests follow), because the claim under test is precisely that
 * `removePane` reaches `disposeAcpForPane` — a claim no pure function can
 * carry, and the exact class of thing that silently rots when a fourth
 * `killTerminalForPane` call site appears.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Pane, TabsState } from "./types";

/**
 * The store's `persist` middleware writes a version key to `localStorage`, and
 * the global test setup stubs `document` but not that. Without a stub every
 * `set()` logs a caught ReferenceError and buries real failures in noise.
 */
if (!("localStorage" in globalThis)) {
	const store = new Map<string, string>();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
			clear: () => store.clear(),
		},
	});
}

const killedTerminals: string[] = [];
const disposedAcp: string[] = [];

mock.module("./utils/terminal-cleanup", () => ({
	killTerminalForPane: (paneId: string) => {
		killedTerminals.push(paneId);
	},
}));
mock.module("./utils/acp-cleanup", () => ({
	disposeAcpForPane: (paneId: string) => {
		disposedAcp.push(paneId);
	},
}));

const { createAcpPane, createAcpTabWithPane } = await import("./utils");
const { TABS_STORE_VERSION, migrateTabsV8ToV9 } = await import(
	"./migrations/v9-acp"
);
const { useTabsStore } = await import("./store");

beforeEach(() => {
	killedTerminals.length = 0;
	disposedAcp.length = 0;
});

// =============================================================================

describe("createAcpPane", () => {
	it("produces a pane of type acp rooted at the given cwd", () => {
		const pane = createAcpPane("tab-1", "/repo/worktree");
		expect(pane).toMatchObject({
			tabId: "tab-1",
			type: "acp",
			name: "ACP Session",
			status: "idle",
			acp: { cwd: "/repo/worktree" },
		});
		expect(pane.id).toStartWith("pane");
	});

	it("does not pre-fill acpSessionId (there is no session yet)", () => {
		expect(createAcpPane("tab-1", "/repo").acp?.acpSessionId).toBeUndefined();
	});

	it("createAcpTabWithPane puts the pane in its own tab's layout", () => {
		const { tab, pane } = createAcpTabWithPane("ws-1", "/repo", []);
		expect(tab.workspaceId).toBe("ws-1");
		expect(tab.layout).toBe(pane.id);
		expect(pane.tabId).toBe(tab.id);
		expect(pane.acp?.cwd).toBe("/repo");
	});
});

describe("persisted store version", () => {
	it("is 9", () => {
		// D3's version boundary. This assertion is the fail-first one: it fails
		// against the unbumped store, where an `acp` sub-state would be persisted
		// under a version that never knew about it.
		expect(TABS_STORE_VERSION).toBe(9);
	});

	it("passes v8 state through unchanged", () => {
		const v8: TabsState = {
			tabs: [
				{
					id: "tab-1",
					name: "Terminal 1",
					workspaceId: "ws-1",
					layout: "pane-1",
					createdAt: 1,
				},
			],
			panes: {
				"pane-1": {
					id: "pane-1",
					tabId: "tab-1",
					type: "terminal",
					name: "Terminal",
				},
			},
			activeTabIds: { "ws-1": "tab-1" },
			focusedPaneIds: { "tab-1": "pane-1" },
			tabHistoryStacks: {},
			closedTabsStack: [],
		} as unknown as TabsState;

		const snapshot = JSON.stringify(v8);
		const migrated = migrateTabsV8ToV9(v8);

		expect(JSON.stringify(migrated)).toBe(snapshot);
	});

	it("round-trips an acp pane's sub-state", () => {
		const state = {
			panes: {
				"pane-1": {
					id: "pane-1",
					tabId: "tab-1",
					type: "acp",
					name: "ACP Session",
					acp: { cwd: "/repo", acpSessionId: "sess-abc" },
				} satisfies Pane,
			},
		} as unknown as TabsState;

		const migrated = migrateTabsV8ToV9(state);
		expect(migrated.panes["pane-1"]?.acp).toEqual({
			cwd: "/repo",
			acpSessionId: "sess-abc",
		});
	});
});

// =============================================================================

function seedPanes(panes: Pane[], layoutTabId = "tab-1"): void {
	const paneMap: Record<string, Pane> = {};
	for (const pane of panes) paneMap[pane.id] = pane;
	useTabsStore.setState({
		tabs: [
			{
				id: layoutTabId,
				name: "Tab",
				workspaceId: "ws-1",
				// A row layout so removing one pane leaves the tab alive.
				layout:
					panes.length > 1
						? {
								direction: "row",
								first: panes[0]?.id ?? "",
								second: panes[1]?.id ?? "",
							}
						: (panes[0]?.id ?? ""),
				createdAt: 1,
			},
		],
		panes: paneMap,
		activeTabIds: { "ws-1": layoutTabId },
		focusedPaneIds: { [layoutTabId]: panes[0]?.id ?? "" },
		tabHistoryStacks: {},
	});
}

describe("cleanup sweep", () => {
	it("removePane on an acp pane disposes the ACP session", () => {
		const acp = createAcpPane("tab-1", "/repo");
		const terminal: Pane = {
			id: "pane-term",
			tabId: "tab-1",
			type: "terminal",
			name: "Terminal",
		};
		seedPanes([acp, terminal]);

		useTabsStore.getState().removePane(acp.id);

		expect(disposedAcp).toEqual([acp.id]);
		expect(killedTerminals).toEqual([]);
	});

	it("removePane on a terminal pane does NOT dispose an ACP session", () => {
		const acp = createAcpPane("tab-1", "/repo");
		const terminal: Pane = {
			id: "pane-term",
			tabId: "tab-1",
			type: "terminal",
			name: "Terminal",
		};
		seedPanes([terminal, acp]);

		useTabsStore.getState().removePane(terminal.id);

		expect(killedTerminals).toEqual([terminal.id]);
		expect(disposedAcp).toEqual([]);
	});

	it("removeTab sweeps every ACP pane in the tab", () => {
		const first = createAcpPane("tab-1", "/repo");
		const second = createAcpPane("tab-1", "/repo");
		seedPanes([first, second]);

		useTabsStore.getState().removeTab("tab-1");

		expect(disposedAcp.sort()).toEqual([first.id, second.id].sort());
	});

	it("updateTabLayout sweeps a pane dropped from the layout", () => {
		// The mosaic close button path: panes vanish from the LAYOUT, and the
		// store has to notice. This is a separate call site from removePane, and
		// it is the one most likely to be forgotten.
		const acp = createAcpPane("tab-1", "/repo");
		const terminal: Pane = {
			id: "pane-term",
			tabId: "tab-1",
			type: "terminal",
			name: "Terminal",
		};
		seedPanes([acp, terminal]);

		useTabsStore.getState().updateTabLayout("tab-1", terminal.id);

		expect(disposedAcp).toEqual([acp.id]);
	});

	it("does not sweep non-subprocess pane types", () => {
		const viewer: Pane = {
			id: "pane-file",
			tabId: "tab-1",
			type: "file-viewer",
			name: "README.md",
			fileViewer: {
				filePath: "README.md",
				viewMode: "raw",
				isPinned: true,
				diffLayout: "inline",
			},
		};
		const terminal: Pane = {
			id: "pane-term",
			tabId: "tab-1",
			type: "terminal",
			name: "Terminal",
		};
		seedPanes([viewer, terminal]);

		useTabsStore.getState().removePane(viewer.id);

		expect(disposedAcp).toEqual([]);
		expect(killedTerminals).toEqual([]);
	});
});
