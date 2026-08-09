/**
 * A small in-memory model of ADE's control plane for tmux-compat tests.
 *
 * It is deliberately a MODEL, not a stub returning fixed values: pane creation
 * has to place the new pane in the right tab and `list-panes` has to reflect
 * closes, or the pruning and re-respawn paths would be tested against a world
 * where nothing ever changes.
 */
import type { ControlApi } from "./translate";

export interface RecordedCall {
	cmd: string;
	args: Record<string, unknown>;
}

export class FakeAde implements ControlApi {
	readonly calls: RecordedCall[] = [];
	/** tabId → ordered ade pane ids. */
	readonly tabs = new Map<string, string[]>();
	focusedTab: string;
	focusedPane: string;
	/** Text written to each pane by `send`, newest last. */
	readonly sent = new Map<string, string[]>();
	/**
	 * How many `pane-ready` polls a NEWLY CREATED pane needs before its PTY is
	 * modelled as alive. 0 (the default) means "ready the instant the layout row
	 * exists", which is what this fake used to assume unconditionally and is
	 * exactly the assumption that hid the respawn race — the real renderer
	 * returns from `new-pane` when the store mutates and spawns the PTY after.
	 * Set it above 0 to model the real two-stage creation.
	 */
	paneReadyAfterPolls = 0;
	/** paneId → `pane-ready` polls seen so far. */
	private readonly readyPolls = new Map<string, number>();
	/** Panes that pre-date the test and are alive from the start. */
	private readonly bornReady = new Set<string>();
	private seq = 0;

	constructor(leaderPaneId = "ade-leader", leaderTabId = "tab-0") {
		this.tabs.set(leaderTabId, [leaderPaneId]);
		this.focusedTab = leaderTabId;
		this.focusedPane = leaderPaneId;
		this.bornReady.add(leaderPaneId);
	}

	/** Whether `send` would land, without consuming a poll. */
	isPaneAlive(paneId: string): boolean {
		if (this.bornReady.has(paneId)) return true;
		return (this.readyPolls.get(paneId) ?? 0) >= this.paneReadyAfterPolls;
	}

	private tabOf(paneId: string): string | undefined {
		for (const [tabId, panes] of this.tabs) {
			if (panes.includes(paneId)) return tabId;
		}
		return undefined;
	}

	private resolvePane(ref: unknown): string {
		const value = String(ref ?? "focused");
		return value === "focused" ? this.focusedPane : value;
	}

	async request(
		cmd: string,
		args: Record<string, unknown> = {},
	): Promise<unknown> {
		this.calls.push({ cmd, args });
		switch (cmd) {
			case "new-tab": {
				const n = ++this.seq;
				const tabId = `tab-${n}`;
				const paneId = `pane-${n}`;
				this.tabs.set(tabId, [paneId]);
				if (args.focus !== false) {
					this.focusedTab = tabId;
					this.focusedPane = paneId;
				}
				return { tabId, paneId, createdPaneIds: [paneId] };
			}
			case "new-pane":
			case "new-split": {
				const source = this.resolvePane(args.pane);
				const tabId = this.tabOf(source);
				if (!tabId) throw new Error(`NOT_FOUND: no such pane ${source}`);
				const n = ++this.seq;
				const paneId = `pane-${n}`;
				const panes = this.tabs.get(tabId) as string[];
				panes.splice(panes.indexOf(source) + 1, 0, paneId);
				if (args.focus !== false) {
					this.focusedTab = tabId;
					this.focusedPane = paneId;
				}
				return { tabId, paneId, createdPaneIds: [paneId] };
			}
			case "close-pane": {
				const paneId = this.resolvePane(args.pane);
				const tabId = this.tabOf(paneId);
				if (!tabId) throw new Error(`NOT_FOUND: no such pane ${paneId}`);
				const panes = (this.tabs.get(tabId) as string[]).filter(
					(id) => id !== paneId,
				);
				if (panes.length === 0) this.tabs.delete(tabId);
				else this.tabs.set(tabId, panes);
				return { applied: ["removePane"] };
			}
			case "focus-pane": {
				const paneId = this.resolvePane(args.pane);
				this.focusedPane = paneId;
				this.focusedTab = this.tabOf(paneId) ?? this.focusedTab;
				return { applied: ["setFocusedPane"] };
			}
			case "list-panes": {
				const tabId = (args.tab as string | undefined) ?? this.focusedTab;
				return {
					tabId,
					panes: (this.tabs.get(tabId) ?? []).map((id, index) => ({
						index: index + 1,
						id,
						type: "terminal",
					})),
				};
			}
			case "list-tabs":
				return { tabs: [...this.tabs.keys()].map((id) => ({ id })) };
			case "pane-ready": {
				const paneId = this.resolvePane(args.pane);
				const seen = (this.readyPolls.get(paneId) ?? 0) + 1;
				this.readyPolls.set(paneId, seen);
				return { paneId, ready: this.isPaneAlive(paneId) };
			}
			case "send": {
				const paneId = this.resolvePane(args.pane);
				// The real server answers NOT_FOUND here (terminal.write throws when
				// the daemon holds no live session for the pane). Modelling the
				// throw is the whole point: a fake that always accepts a write
				// cannot fail on the race it is meant to cover.
				if (!this.isPaneAlive(paneId)) {
					throw new Error(
						`NOT_FOUND: Pane ${paneId} has no live terminal session`,
					);
				}
				const list = this.sent.get(paneId) ?? [];
				list.push(String(args.text ?? ""));
				this.sent.set(paneId, list);
				return {};
			}
			case "send-key":
				return {};
			case "capture-pane":
				return { text: "screen contents\n" };
			default:
				return {};
		}
	}
}
