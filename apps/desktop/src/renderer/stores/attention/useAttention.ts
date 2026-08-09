/**
 * Renderer's read side of the attention inbox (Mission Control Feature 3).
 *
 * The store itself is in main (SQLite). This file is query + invalidation, the
 * same shape the rest of the app uses for main-owned state: one subscription
 * mounted once at the authenticated layout invalidates the query, and every
 * consumer just calls `useAttention()` — React Query dedupes the fetch, so a
 * badge on every tab and every workspace rail entry is still one read.
 *
 * Deliberately NOT a zustand store. The tabs store is renderer-owned state that
 * main mirrors; this is the opposite direction, and giving it a store would
 * create a second copy that can disagree with the database.
 */
import { electronTrpc } from "renderer/lib/electron-trpc";

export interface AttentionNotification {
	id: string;
	kind: "attention" | "custom";
	title: string;
	body: string;
	paneId: string | null;
	workspaceId: string | null;
	createdAt: number;
	readAt: number | null;
}

export interface AttentionState {
	notifications: AttentionNotification[];
	/** Unread of BOTH kinds — what the Dock and the panel button show. */
	unread: number;
	/** paneId → unread ATTENTION count. Custom notifications are excluded. */
	unreadAttentionByPane: Record<string, number>;
}

const EMPTY: AttentionState = {
	notifications: [],
	unread: 0,
	unreadAttentionByPane: {},
};

export function useAttention(): AttentionState {
	const { data } = electronTrpc.attention.list.useQuery(
		{},
		{
			// Refetching is driven by useAttentionSync's invalidation, not by a
			// poll: notifications are rare and a timer would spend a query per
			// interval to learn nothing.
			staleTime: Number.POSITIVE_INFINITY,
		},
	);
	return (data as AttentionState | undefined) ?? EMPTY;
}

/**
 * Unread attention count for a set of panes — the number a tab badge shows.
 * Takes the pane ids rather than a tabId so the caller (which already has the
 * tab→pane mapping in the tabs store) does not need this module to know about
 * mosaic layouts.
 */
export function countAttentionForPanes(
	byPane: Record<string, number>,
	paneIds: Iterable<string>,
): number {
	let total = 0;
	for (const paneId of paneIds) total += byPane[paneId] ?? 0;
	return total;
}

/**
 * Mount ONCE (authenticated layout). Keeps the query fresh by invalidating it
 * whenever main reports a change.
 */
export function useAttentionSync(): void {
	const utils = electronTrpc.useUtils();
	electronTrpc.attention.changed.useSubscription(undefined, {
		onData: () => {
			void utils.attention.list.invalidate();
		},
		onError: (error) => {
			console.error("[attention] subscription error:", error);
		},
	});
}
