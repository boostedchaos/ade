import { optionalBoolean, optionalString, requireString } from "../args";
import type { NotificationsHost } from "../host";
import { ControlError } from "../protocol";
import type { AuthenticatedSession, CommandRegistry } from "../server";
import { focusedPaneId, requirePane } from "../snapshot";
import { resolveTarget } from "../target-resolution";

/**
 * Attention notifications group (Mission Control Feature 3).
 *
 * The store itself lives in main (apps/desktop/src/main/lib/attention/) and is
 * reached through `host.notifications`; this file is the wire surface plus the
 * one piece of real logic the command owns — the jump-to-unread cursor.
 *
 * `notification` bus events are emitted by the STORE, not from here, so that a
 * row created automatically by an agent transition and one created by `notify`
 * produce the same event. Emitting here would cover only the second.
 */

function requireNotifications(
	session: AuthenticatedSession,
): NotificationsHost {
	const notifications = session.host.notifications;
	if (!notifications) {
		throw new ControlError(
			"UNSUPPORTED",
			"This ADE build does not track notifications",
		);
	}
	return notifications;
}

/**
 * PURE. Which pane `jump-to-unread` focuses next.
 *
 * The cursor is DERIVED from what currently has focus rather than stored
 * server-side. That is what makes repeated CLI invocations behave sensibly
 * without ADE and the CLI sharing a position that the user can invalidate at
 * any moment by clicking a pane themselves.
 *
 * - no candidates → null
 * - focused pane is not a candidate → the newest candidate
 * - focused pane IS a candidate → the next one, wrapping
 */
export function nextUnreadPane(
	candidates: string[],
	focused: string | null,
): string | null {
	if (candidates.length === 0) return null;
	const index = focused ? candidates.indexOf(focused) : -1;
	if (index === -1) return candidates[0] ?? null;
	return candidates[(index + 1) % candidates.length] ?? null;
}

export const notificationCommands: CommandRegistry = {
	notify: (session, args) => {
		const notifications = requireNotifications(session);
		const snapshot = session.host.getSnapshot();

		const paneRef = optionalString(args, "pane");
		let paneId: string | null = null;
		let workspaceId: string | null = null;
		if (paneRef) {
			paneId = resolveTarget(snapshot, "pane", paneRef);
			const tabId = requirePane(snapshot, paneId).tabId;
			workspaceId =
				snapshot.tabs.find((tab) => tab.id === tabId)?.workspaceId ?? null;
		}

		const record = notifications.create({
			kind: "custom",
			title: requireString(args, "title"),
			body: optionalString(args, "body") ?? "",
			paneId,
			workspaceId,
		});
		if (!record) {
			throw new ControlError("INTERNAL", "Could not store the notification");
		}
		return record;
	},

	"list-notifications": (session, args) => {
		const notifications = requireNotifications(session);
		const unreadOnly = optionalBoolean(args, "unread", false);
		const records = notifications.list({ unreadOnly });
		return {
			notifications: records,
			unread: records.filter((record) => record.readAt === null).length,
		};
	},

	/**
	 * `{all: true}` and `{id}` are separate arguments rather than an id of
	 * "all": a notification id is a UUID the caller pastes, and a magic string
	 * in that position would be a target ambiguity waiting to happen.
	 */
	"mark-notification-read": (session, args) => {
		const notifications = requireNotifications(session);
		if (optionalBoolean(args, "all", false)) {
			return { marked: notifications.markAllRead(), all: true };
		}
		const id = requireString(args, "id");
		return { marked: notifications.markRead(id) ? 1 : 0, all: false, id };
	},

	"jump-to-unread": async (session) => {
		const notifications = requireNotifications(session);
		const snapshot = session.host.getSnapshot();

		// Filter to panes that still exist: a notification outlives its pane, and
		// focusing a dead pane id would fail in the renderer rather than skipping
		// to the next real one.
		const candidates = notifications
			.panesWithUnreadAttention()
			.filter((paneId) => snapshot.panes[paneId] !== undefined);

		const target = nextUnreadPane(candidates, focusedPaneId(snapshot));
		if (!target) {
			return { jumped: false, paneId: null, remaining: 0 };
		}

		const pane = requirePane(snapshot, target);
		const tab = snapshot.tabs.find((t) => t.id === pane.tabId);
		if (!tab) {
			throw new ControlError("NOT_FOUND", `Pane ${target} has no tab`);
		}

		await session.host.dispatchToRenderer({
			kind: "focus-pane",
			paneId: target,
			tabId: tab.id,
			workspaceId: tab.workspaceId,
		});

		// Focusing does NOT mark read. The notification clears when the agent
		// leaves needsInput (main/lib/attention marks the pane's rows read on that
		// transition), so a jump that lands on a pane still waiting for you leaves
		// the badge up — which is the honest state.
		return { jumped: true, paneId: target, remaining: candidates.length };
	},
};
