/**
 * "just now" / "4m ago" / "2h ago" / "3d ago".
 *
 * Lifted out of NotificationPanel so the blocked-session strip and the rail's
 * attention reason phrase an age exactly the same way the notification panel
 * does — two spellings of the same age in one window reads as a bug.
 */
export function relativeTime(
	timestamp: number,
	now: number = Date.now(),
): string {
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}
