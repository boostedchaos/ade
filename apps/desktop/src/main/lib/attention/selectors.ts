/**
 * PURE aggregation over notification records.
 *
 * Split out from index.ts so the parts with real logic — the badge counts and
 * especially the jump-to-unread cursor — are unit-testable without a database,
 * an Electron app object or a renderer. index.ts is then only wiring.
 */
import type { NotificationRecord } from "./store";

export function isUnread(record: NotificationRecord): boolean {
	return record.readAt === null;
}

export function unreadCount(records: NotificationRecord[]): number {
	return records.filter(isUnread).length;
}

/**
 * Unread ATTENTION rows per pane. Custom `ade notify` rows are excluded: the
 * ring, the tab badge and the rail badge all mean "an agent is blocked on
 * you", and a build-finished announcement must not be able to say that.
 */
export function unreadAttentionByPane(
	records: NotificationRecord[],
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const record of records) {
		if (!isUnread(record)) continue;
		if (record.kind !== "attention") continue;
		if (!record.paneId) continue;
		counts[record.paneId] = (counts[record.paneId] ?? 0) + 1;
	}
	return counts;
}

/**
 * Panes with unread attention, newest ask first.
 *
 * A pane appears once even when it has several unread rows — jump-to-unread
 * cycles PANES, not notifications, and visiting a pane clears all of its rows
 * at once.
 */
export function panesWithUnreadAttention(
	records: NotificationRecord[],
): string[] {
	const seen = new Set<string>();
	const order: string[] = [];
	// Sorted rather than assuming the caller's order: the cycle position is
	// user-visible, so it must not depend on how the rows came out of SQLite.
	const sorted = [...records].sort((a, b) => b.createdAt - a.createdAt);
	for (const record of sorted) {
		if (!isUnread(record)) continue;
		if (record.kind !== "attention") continue;
		if (!record.paneId) continue;
		if (seen.has(record.paneId)) continue;
		seen.add(record.paneId);
		order.push(record.paneId);
	}
	return order;
}

// The jump-to-unread cursor deliberately does NOT live here. It is
// `nextUnreadPane` in packages/control-plane/src/commands/notifications.ts,
// next to the only command that uses it — a second copy here would be one more
// place for the wrap behaviour to drift.

/**
 * The macOS Dock badge string for an unread count. Empty string clears the
 * badge — `app.dock.setBadge("0")` would paint a literal zero.
 */
export function dockBadgeText(count: number): string {
	if (count <= 0) return "";
	return count > 99 ? "99+" : String(count);
}

/**
 * The Windows taskbar overlay-icon key for an unread count, or null to clear.
 *
 * Doubles as the badge PNG's identity (see lib/attention/overlay-badge.ts).
 * Capped at "9+" rather than the Dock's "99+": an overlay icon renders at
 * ~16x16, where a two-glyph "99+" is an unreadable smear — a single digit plus
 * a "more" marker is the most a badge that size can legibly carry.
 */
export function overlayBadgeKey(count: number): string | null {
	if (count <= 0) return null;
	return count > 9 ? "9+" : String(count);
}

/**
 * Paint both platform badges for an unread count. The one seam the badge tests
 * exercise with a mock sink — no Electron, no BrowserWindow, no DB. The Dock
 * gets its text; Windows gets the raw count and maps it to an overlay image in
 * the sink implementation (windows/main.ts), so a count of 0 forwards through
 * to a clear.
 */
export function paintBadges(
	sink: {
		setDockBadge: (text: string) => void;
		setOverlayBadge?: (count: number) => void;
	},
	count: number,
): void {
	sink.setDockBadge(dockBadgeText(count));
	sink.setOverlayBadge?.(count);
}
