/**
 * Persistence + queries for the attention inbox (Mission Control Feature 3).
 *
 * Deliberately a thin, synchronous wrapper over the `notifications` table
 * rather than an in-memory registry with a snapshot table behind it (the shape
 * Feature 2 used for agent sessions). The reason is the access pattern: agent
 * state is written on every tool call and read constantly, so it belongs in
 * memory; notifications are written a handful of times an hour and read when a
 * panel opens. better-sqlite3 is synchronous, so a query per read costs less
 * than the staleness window a cache would add.
 *
 * Every write is best-effort. A notification is a UI affordance; a DB error
 * must not unwind the hook request or the control-socket command that caused
 * it.
 */
import { notifications } from "@superset/local-db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { localDb } from "../local-db";

export type NotificationKind = "attention" | "custom";

export interface NotificationRecord {
	id: string;
	kind: NotificationKind;
	title: string;
	body: string;
	paneId: string | null;
	workspaceId: string | null;
	createdAt: number;
	readAt: number | null;
}

export interface CreateNotificationInput {
	kind: NotificationKind;
	title: string;
	body?: string;
	paneId?: string | null;
	workspaceId?: string | null;
	createdAt?: number;
}

function toRecord(row: {
	id: string;
	kind: string;
	title: string;
	body: string;
	paneId: string | null;
	workspaceId: string | null;
	createdAt: number;
	readAt: number | null;
}): NotificationRecord {
	return {
		id: row.id,
		kind: row.kind === "custom" ? "custom" : "attention",
		title: row.title,
		body: row.body,
		paneId: row.paneId ?? null,
		workspaceId: row.workspaceId ?? null,
		createdAt: row.createdAt,
		readAt: row.readAt ?? null,
	};
}

/** Newest first. `unreadOnly` filters to rows with no readAt. */
export function listNotifications(
	options: { unreadOnly?: boolean; limit?: number } = {},
): NotificationRecord[] {
	try {
		const query = localDb.select().from(notifications);
		const rows = options.unreadOnly
			? query
					.where(isNull(notifications.readAt))
					.orderBy(desc(notifications.createdAt))
					.limit(options.limit ?? 200)
					.all()
			: query
					.orderBy(desc(notifications.createdAt))
					.limit(options.limit ?? 200)
					.all();
		return rows.map(toRecord);
	} catch (error) {
		console.error("[attention] Failed to list notifications:", error);
		return [];
	}
}

/** Returns null when the insert failed — callers must not assume success. */
export function insertNotification(
	input: CreateNotificationInput,
): NotificationRecord | null {
	try {
		const [row] = localDb
			.insert(notifications)
			.values({
				kind: input.kind,
				title: input.title,
				body: input.body ?? "",
				paneId: input.paneId ?? null,
				workspaceId: input.workspaceId ?? null,
				createdAt: input.createdAt ?? Date.now(),
			})
			.returning()
			.all();
		return row ? toRecord(row) : null;
	} catch (error) {
		console.error("[attention] Failed to create notification:", error);
		return null;
	}
}

/** Number of rows actually marked. 0 means nothing changed. */
export function markNotificationRead(id: string, at = Date.now()): number {
	try {
		const rows = localDb
			.update(notifications)
			.set({ readAt: at })
			.where(and(eq(notifications.id, id), isNull(notifications.readAt)))
			.returning({ id: notifications.id })
			.all();
		return rows.length;
	} catch (error) {
		console.error("[attention] Failed to mark notification read:", error);
		return 0;
	}
}

export function markAllNotificationsRead(at = Date.now()): number {
	try {
		const rows = localDb
			.update(notifications)
			.set({ readAt: at })
			.where(isNull(notifications.readAt))
			.returning({ id: notifications.id })
			.all();
		return rows.length;
	} catch (error) {
		console.error("[attention] Failed to mark notifications read:", error);
		return 0;
	}
}

/**
 * Mark every unread row for one pane. Called when the user focuses a pane that
 * was asking for attention — the ask has been seen, so the badge must clear
 * without the user visiting the panel.
 */
export function markPaneNotificationsRead(
	paneId: string,
	at = Date.now(),
): number {
	try {
		const rows = localDb
			.update(notifications)
			.set({ readAt: at })
			.where(
				and(eq(notifications.paneId, paneId), isNull(notifications.readAt)),
			)
			.returning({ id: notifications.id })
			.all();
		return rows.length;
	} catch (error) {
		console.error("[attention] Failed to mark pane notifications read:", error);
		return 0;
	}
}

export function getNotification(id: string): NotificationRecord | null {
	try {
		const row = localDb
			.select()
			.from(notifications)
			.where(eq(notifications.id, id))
			.get();
		return row ? toRecord(row) : null;
	} catch (error) {
		console.error("[attention] Failed to read notification:", error);
		return null;
	}
}

/**
 * Is there already an unread ATTENTION row for this pane?
 *
 * The dedupe that keeps a chatty agent from stacking twenty identical "needs
 * input" rows for one pane: while the previous ask is unread, the pane is
 * already flagged and a second row would add nothing but a wrong badge count.
 */
export function hasUnreadAttentionForPane(paneId: string): boolean {
	try {
		const row = localDb
			.select({ id: notifications.id })
			.from(notifications)
			.where(
				and(
					eq(notifications.paneId, paneId),
					eq(notifications.kind, "attention"),
					isNull(notifications.readAt),
				),
			)
			.get();
		return row !== undefined;
	} catch (error) {
		console.error("[attention] Failed to check pane attention:", error);
		return false;
	}
}
