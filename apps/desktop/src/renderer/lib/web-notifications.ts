import type { NotificationIds } from "shared/notification-types";

/**
 * Web Notification API bridge for the browser shell (apps/webui).
 *
 * The Electron desktop surfaces agent "attention" events (an agent finished a
 * task, or an agent needs a permission/input) through the OS Notification
 * Center via the main-process `NotificationManager`. On web there is no native
 * main process, so this fires the standard `Notification` API on the SAME
 * events, with the SAME semantics:
 *
 *  - Suppress when the user is already looking (page visible + focused).
 *  - "Agent Complete — <workspace>" on Stop, "Input Needed — <workspace>" on
 *    PermissionRequest — matching the desktop titles/bodies.
 *  - Click focuses the tab.
 *
 * Plus the two browser-only concerns the desktop never had:
 *
 *  - Permission is requested lazily, on the FIRST attention-worthy event —
 *    never on page load (a load-time prompt is user-hostile and often ignored).
 *  - A hard no-op when the API is missing (iOS Safari outside a PWA has no
 *    `Notification`) or permission is denied — it must never throw.
 *
 * The class takes its browser touchpoints as injected deps so the
 * trigger→notify mapping is unit-testable without a DOM; `getWebNotifier()`
 * returns a process-wide singleton wired to the real browser APIs.
 */

export type WebNotificationKind = "complete" | "permission";

export interface WebNotificationHandle {
	setOnClick(handler: () => void): void;
	close(): void;
}

export interface WebNotifierDeps {
	/** `"Notification" in window` — false on iOS Safari outside a PWA. */
	isSupported(): boolean;
	/** `Notification.permission`. */
	getPermission(): NotificationPermission;
	/** `Notification.requestPermission()`. */
	requestPermission(): Promise<NotificationPermission>;
	/** Construct a native notification and return a handle to it. */
	createNotification(opts: {
		title: string;
		body: string;
		tag: string;
		silent: boolean;
	}): WebNotificationHandle;
	/** True when the page is visible AND focused (the user is already looking). */
	isPageVisible(): boolean;
	/** Bring this window/tab to the foreground (`window.focus()`). */
	focusWindow(): void;
}

export interface WebNotifyInput {
	kind: WebNotificationKind;
	/** Workspace/agent display name (the notification title suffix). */
	workspaceName: string;
	/** Tab/pane title (quoted in the notification body). */
	itemTitle: string;
	/** Target IDs handed back to `onActivate` when the notification is clicked. */
	ids: NotificationIds;
	/** Whether notification sound is muted (the shared `notificationSoundsMuted`). */
	muted: boolean;
	/** Invoked after `focusWindow()` when the notification is clicked. */
	onActivate(ids: NotificationIds): void;
}

/** Why a `notify()` call did or didn't surface a notification (aids testing/telemetry). */
export type WebNotifyResult =
	| "shown"
	| "suppressed-visible"
	| "unsupported"
	| "denied";

function renderContent(
	kind: WebNotificationKind,
	workspaceName: string,
	itemTitle: string,
): { title: string; body: string } {
	if (kind === "permission") {
		return {
			title: `Input Needed — ${workspaceName}`,
			body: `"${itemTitle}" needs your attention`,
		};
	}
	return {
		title: `Agent Complete — ${workspaceName}`,
		body: `"${itemTitle}" has finished its task`,
	};
}

export class WebNotifier {
	/**
	 * We only ever prompt once per page session. If the user dismisses the
	 * prompt (leaving permission at "default"), we don't nag on every later
	 * event — matching the OS-notification convention.
	 */
	private permissionRequested = false;

	constructor(private readonly deps: WebNotifierDeps) {}

	async notify(input: WebNotifyInput): Promise<WebNotifyResult> {
		if (!this.deps.isSupported()) return "unsupported";

		// The user is already looking at the page — no need to interrupt them.
		if (this.deps.isPageVisible()) return "suppressed-visible";

		let permission = this.deps.getPermission();

		if (permission === "denied") return "denied";

		if (permission === "default") {
			if (this.permissionRequested) {
				// Already asked this session; the user dismissed it. Stay quiet.
				return "denied";
			}
			this.permissionRequested = true;
			try {
				permission = await this.deps.requestPermission();
			} catch {
				// Some browsers (e.g. Safari) reject when not tied to a user
				// gesture. Treat as a graceful no-op.
				return "denied";
			}
			if (permission !== "granted") return "denied";

			// The permission round-trip is async — re-check visibility in case
			// the user tabbed back while the prompt was up.
			if (this.deps.isPageVisible()) return "suppressed-visible";
		}

		const { title, body } = renderContent(
			input.kind,
			input.workspaceName,
			input.itemTitle,
		);

		const handle = this.deps.createNotification({
			title,
			body,
			// Coalesce repeated events for the same pane into one notification.
			tag: input.ids.paneId ?? `ade-${input.kind}`,
			silent: input.muted,
		});

		handle.setOnClick(() => {
			this.deps.focusWindow();
			input.onActivate(input.ids);
			handle.close();
		});

		return "shown";
	}
}

function browserNotifierDeps(): WebNotifierDeps {
	return {
		isSupported: () =>
			typeof window !== "undefined" && "Notification" in window,
		getPermission: () => {
			try {
				return Notification.permission;
			} catch {
				return "denied";
			}
		},
		requestPermission: () => Notification.requestPermission(),
		createNotification: (opts) => {
			const notification = new Notification(opts.title, {
				body: opts.body,
				tag: opts.tag,
				silent: opts.silent,
			});
			return {
				setOnClick: (handler) => {
					notification.onclick = handler;
				},
				close: () => notification.close(),
			};
		},
		isPageVisible: () => {
			try {
				return document.visibilityState === "visible" && document.hasFocus();
			} catch {
				return false;
			}
		},
		focusWindow: () => {
			try {
				window.focus();
			} catch {
				// no-op
			}
		},
	};
}

let singleton: WebNotifier | null = null;

/** Process-wide notifier wired to the real browser APIs. */
export function getWebNotifier(): WebNotifier {
	if (!singleton) {
		singleton = new WebNotifier(browserNotifierDeps());
	}
	return singleton;
}
