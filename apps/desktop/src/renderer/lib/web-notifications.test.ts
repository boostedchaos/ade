import { beforeEach, describe, expect, it } from "bun:test";
import {
	type WebNotificationHandle,
	WebNotifier,
	type WebNotifierDeps,
	type WebNotifyInput,
} from "./web-notifications";

interface CreatedNotification {
	title: string;
	body: string;
	tag: string;
	silent: boolean;
	handle: WebNotificationHandle;
	onClick: (() => void) | null;
	closed: boolean;
}

interface Harness {
	deps: WebNotifierDeps;
	created: CreatedNotification[];
	requestCount: number;
	focusCount: number;
	setPermission: (p: NotificationPermission) => void;
	setVisible: (v: boolean) => void;
}

function makeHarness(overrides: Partial<WebNotifierDeps> = {}): Harness {
	let permission: NotificationPermission = "granted";
	let visible = false;
	let requestCount = 0;
	let focusCount = 0;
	const created: CreatedNotification[] = [];

	const deps: WebNotifierDeps = {
		isSupported: () => true,
		getPermission: () => permission,
		requestPermission: async () => {
			requestCount++;
			return permission;
		},
		createNotification: (opts) => {
			const record: CreatedNotification = {
				...opts,
				onClick: null,
				closed: false,
				handle: {
					setOnClick: (handler) => {
						record.onClick = handler;
					},
					close: () => {
						record.closed = true;
					},
				},
			};
			created.push(record);
			return record.handle;
		},
		isPageVisible: () => visible,
		focusWindow: () => {
			focusCount++;
		},
		...overrides,
	};

	return {
		deps,
		created,
		get requestCount() {
			return requestCount;
		},
		get focusCount() {
			return focusCount;
		},
		setPermission: (p) => {
			permission = p;
		},
		setVisible: (v) => {
			visible = v;
		},
	};
}

function makeInput(overrides: Partial<WebNotifyInput> = {}): WebNotifyInput {
	return {
		kind: "complete",
		workspaceName: "Cicero",
		itemTitle: "Nightly maintenance",
		ids: { paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-1" },
		muted: false,
		onActivate: () => {},
		...overrides,
	};
}

describe("WebNotifier", () => {
	let h: Harness;
	let notifier: WebNotifier;

	beforeEach(() => {
		h = makeHarness();
		notifier = new WebNotifier(h.deps);
	});

	it("no-ops when the Notification API is unsupported", async () => {
		const local = makeHarness({ isSupported: () => false });
		const result = await new WebNotifier(local.deps).notify(makeInput());
		expect(result).toBe("unsupported");
		expect(local.created).toHaveLength(0);
	});

	it("suppresses when the page is visible+focused", async () => {
		h.setVisible(true);
		const result = await notifier.notify(makeInput());
		expect(result).toBe("suppressed-visible");
		expect(h.created).toHaveLength(0);
	});

	it("no-ops when permission is already denied (no prompt)", async () => {
		h.setPermission("denied");
		const result = await notifier.notify(makeInput());
		expect(result).toBe("denied");
		expect(h.requestCount).toBe(0);
		expect(h.created).toHaveLength(0);
	});

	it("shows when permission is already granted", async () => {
		const result = await notifier.notify(makeInput());
		expect(result).toBe("shown");
		expect(h.requestCount).toBe(0);
		expect(h.created).toHaveLength(1);
	});

	it("requests permission on the first event when default, then shows if granted", async () => {
		h.setPermission("default");
		// requestPermission resolves to the *current* permission; flip it to
		// granted before the call resolves.
		const local = makeHarness();
		local.setPermission("default");
		let asked = 0;
		const deps: WebNotifierDeps = {
			...local.deps,
			requestPermission: async () => {
				asked++;
				return "granted";
			},
		};
		const result = await new WebNotifier(deps).notify(makeInput());
		expect(asked).toBe(1);
		expect(result).toBe("shown");
		expect(local.created).toHaveLength(1);
	});

	it("does not prompt on page load — only requests on an actual event", () => {
		// Constructing the notifier must not touch permission at all.
		new WebNotifier(h.deps);
		expect(h.requestCount).toBe(0);
	});

	it("prompts at most once per session when the user dismisses it", async () => {
		h.setPermission("default");
		let asked = 0;
		const deps: WebNotifierDeps = {
			...h.deps,
			// User dismisses the prompt: permission stays "default".
			requestPermission: async () => {
				asked++;
				return "default";
			},
		};
		const n = new WebNotifier(deps);
		expect(await n.notify(makeInput())).toBe("denied");
		expect(await n.notify(makeInput())).toBe("denied");
		// Only the first event triggered a prompt.
		expect(asked).toBe(1);
	});

	it("maps a Stop/complete event to the agent-complete copy", async () => {
		await notifier.notify(makeInput({ kind: "complete" }));
		expect(h.created[0].title).toBe("Agent Complete — Cicero");
		expect(h.created[0].body).toBe(
			'"Nightly maintenance" has finished its task',
		);
	});

	it("maps a PermissionRequest event to the input-needed copy", async () => {
		await notifier.notify(makeInput({ kind: "permission" }));
		expect(h.created[0].title).toBe("Input Needed — Cicero");
		expect(h.created[0].body).toBe(
			'"Nightly maintenance" needs your attention',
		);
	});

	it("tags notifications by paneId so repeats coalesce", async () => {
		await notifier.notify(makeInput({ ids: { paneId: "pane-42" } }));
		expect(h.created[0].tag).toBe("pane-42");
	});

	it("falls back to a kind-based tag when there is no paneId", async () => {
		await notifier.notify(makeInput({ kind: "permission", ids: {} }));
		expect(h.created[0].tag).toBe("ade-permission");
	});

	it("passes the muted flag through as the notification's silent option", async () => {
		await notifier.notify(makeInput({ muted: true }));
		expect(h.created[0].silent).toBe(true);
		await notifier.notify(makeInput({ muted: false }));
		expect(h.created[1].silent).toBe(false);
	});

	it("focuses the window and activates the tab on click, then closes", async () => {
		let activatedWith: unknown = null;
		const ids = { paneId: "pane-9", tabId: "tab-9", workspaceId: "ws-9" };
		await notifier.notify(
			makeInput({
				ids,
				onActivate: (activateIds) => {
					activatedWith = activateIds;
				},
			}),
		);
		const record = h.created[0];
		expect(record.onClick).not.toBeNull();
		record.onClick?.();
		expect(h.focusCount).toBe(1);
		expect(activatedWith).toEqual(ids);
		expect(record.closed).toBe(true);
	});
});
