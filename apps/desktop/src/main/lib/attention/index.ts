/**
 * Attention notifications (Mission Control Feature 3) — main-process wiring.
 *
 * Two producers write here and there is exactly one of each:
 *
 *  1. AUTOMATIC. This module subscribes to the AgentSession registry's
 *     transitions and creates an `attention` row when a pane enters
 *     `needsInput`. It subscribes to the registry rather than to the HTTP hook
 *     receiver so that BOTH doors onto Feature 2 — the receiver and `ade
 *     agent-event` over the control socket — produce a notification, without
 *     this file knowing either door exists.
 *  2. EXPLICIT. `ade notify` creates a `custom` row through `createNotification`.
 *
 * Reading is symmetrical: leaving `needsInput` marks that pane's unread rows
 * read, because the ask has been answered. That is what keeps the badge honest
 * with no renderer plumbing — nothing has to remember to clear it.
 *
 * NATIVE OS NOTIFICATIONS ARE DELIBERATELY NOT FIRED FOR THE AUTOMATIC PATH.
 * `NotificationManager` (lib/notifications/notification-manager.ts) already
 * shows one for every hook event that maps to `PermissionRequest` — the same
 * event set that maps to `needsInput` — with pane-visibility suppression and
 * click-to-focus. Firing a second one here would give two toasts per permission
 * request. See the comment on `notifyNatively` for the one gap this leaves.
 */

import {
	type AgentSessionTransition,
	getAgentSessionRegistry,
} from "../agent-sessions";
import { getControlPlaneEvents } from "../control-plane";
import { dockBadgeText, unreadCount } from "./selectors";
import {
	type CreateNotificationInput,
	hasUnreadAttentionForPane,
	insertNotification,
	listNotifications,
	markAllNotificationsRead,
	markNotificationRead,
	markPaneNotificationsRead,
	type NotificationRecord,
} from "./store";

export * from "./selectors";
export * from "./store";

type ChangeListener = () => void;

const changeListeners = new Set<ChangeListener>();
let unsubscribeRegistry: (() => void) | null = null;

/**
 * Injected rather than imported so this module stays testable and does not
 * reach into Electron. windows/main.ts supplies both.
 */
export interface AttentionDeps {
	/** Paints the macOS Dock badge. No-op on other platforms. */
	setDockBadge: (text: string) => void;
	/**
	 * Shows an OS notification whose click focuses `paneId`. Only used for
	 * EXPLICIT `ade notify` — see the file header.
	 */
	showNativeNotification: (input: {
		title: string;
		body: string;
		paneId: string | null;
		workspaceId: string | null;
	}) => void;
	/** Display name for the pane a notification is about, for the toast body. */
	describePane?: (paneId: string) => string;
}

let deps: AttentionDeps | null = null;

export function setAttentionDeps(next: AttentionDeps | null): void {
	deps = next;
	// A late wiring must not leave a stale badge from before the app had a dock.
	if (next) refreshDockBadge();
}

/** Renderer sync: fires after any change to the notification set. */
export function onAttentionChanged(fn: ChangeListener): () => void {
	changeListeners.add(fn);
	return () => {
		changeListeners.delete(fn);
	};
}

function emitChanged(): void {
	refreshDockBadge();
	for (const fn of changeListeners) {
		try {
			fn();
		} catch (error) {
			console.error("[attention] change listener threw:", error);
		}
	}
}

function refreshDockBadge(): void {
	if (!deps) return;
	try {
		// unreadOnly, or the badge silently stops counting anything older than
		// the newest 200 rows — and rows are never deleted.
		deps.setDockBadge(
			dockBadgeText(unreadCount(listNotifications({ unreadOnly: true }))),
		);
	} catch (error) {
		console.error("[attention] Failed to update dock badge:", error);
	}
}

/** Total unread, both kinds. This is the number on the Dock and the rail. */
export function unreadNotificationCount(): number {
	return unreadCount(listNotifications({ unreadOnly: true }));
}

/**
 * Create a notification, publish it, and (for explicit ones) show a toast.
 * Returns null when the row could not be written.
 */
export function createNotification(
	input: CreateNotificationInput,
): NotificationRecord | null {
	const record = insertNotification(input);
	if (!record) return null;

	getControlPlaneEvents()?.emit("notification", {
		id: record.id,
		kind: record.kind,
		title: record.title,
		body: record.body,
		paneId: record.paneId,
		workspaceId: record.workspaceId,
		unread: record.readAt === null,
	});

	if (record.kind === "custom") notifyNatively(record);
	emitChanged();
	return record;
}

/**
 * The ONE native-notification call in this feature.
 *
 * Restricted to `custom` rows for the reason in the file header. The gap that
 * leaves: a `needsInput` arriving via `ade agent-event` over the control socket
 * (rather than the HTTP hook receiver) gets a record, a ring, badges and a
 * panel entry, but no OS toast — because nothing on that path emits the
 * AgentLifecycleEvent that NotificationManager listens to. ADE's own installed
 * hooks use the HTTP door, so this affects only hooks ADE did not write.
 * Closing it properly means one notification decision point, which is a change
 * to the existing lifecycle pipeline and not this phase's to make.
 */
function notifyNatively(record: NotificationRecord): void {
	if (!deps) return;
	try {
		deps.showNativeNotification({
			title: record.title,
			body: record.body,
			paneId: record.paneId,
			workspaceId: record.workspaceId,
		});
	} catch (error) {
		console.error("[attention] Failed to show native notification:", error);
	}
}

export function markRead(id: string): boolean {
	const changed = markNotificationRead(id) > 0;
	if (changed) emitChanged();
	return changed;
}

export function markAllRead(): number {
	const count = markAllNotificationsRead();
	if (count > 0) emitChanged();
	return count;
}

export function markPaneRead(paneId: string): number {
	const count = markPaneNotificationsRead(paneId);
	if (count > 0) emitChanged();
	return count;
}

/**
 * A pane entered or left `needsInput`.
 *
 * Exported for tests; the live path is the registry subscription below.
 */
export function handleAgentTransition(
	transition: AgentSessionTransition,
): void {
	if (transition.to === "needsInput") {
		// Dedupe: while the previous ask for this pane is still unread the pane
		// is already flagged, and a second row would only inflate the badge.
		if (hasUnreadAttentionForPane(transition.surfaceId)) return;

		const paneName =
			deps?.describePane?.(transition.surfaceId) ?? "A terminal pane";
		createNotification({
			kind: "attention",
			title: `${paneName} needs input`,
			body: "The agent is waiting on you.",
			paneId: transition.surfaceId,
			workspaceId: transition.workspaceId,
			createdAt: transition.at,
		});
		return;
	}

	// Left needsInput → the ask was answered. Clearing here rather than on pane
	// focus means the badge is driven by the same authority as the ring (hooks),
	// not by a second guess about what the user has seen.
	if (transition.from === "needsInput") {
		markPaneRead(transition.surfaceId);
	}
}

export function startAttentionTracking(): void {
	if (unsubscribeRegistry) return;
	unsubscribeRegistry = getAgentSessionRegistry().onTransition(
		handleAgentTransition,
	);
	refreshDockBadge();
}

export function stopAttentionTracking(): void {
	unsubscribeRegistry?.();
	unsubscribeRegistry = null;
}
