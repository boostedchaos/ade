import { useMemo } from "react";
import { useTabsStore } from "renderer/stores";
import { useAttention } from "renderer/stores/attention/useAttention";
import type { Pane } from "shared/tabs-types";

/**
 * The one blocked agent worth interrupting you about.
 *
 * Feeds the rail's attention reason and the blocked-session strip
 * (DESIGN-BRIEF.md §2a, both marked "additive"). Every field below comes from
 * something the app already tracks — pane status, the attention inbox's
 * `createdAt`/`body`, and the tabs store's names. No new persistent state.
 */
export interface BlockedAgent {
	paneId: string;
	workspaceId: string | null;
	/** The session (pane) name — `migrations` in the mock. */
	sessionName: string;
	/**
	 * Why it is blocked, e.g. "needs an answer on the migration order".
	 * Null when the pane is in `permission` but no attention notification
	 * explains it — the strip still renders, without a reason.
	 */
	reason: string | null;
	/** When the agent asked, for "asked 4m ago". Null if unknown. */
	askedAt: number | null;
}

/**
 * Blocked agents keyed by pane id, so a rail row can look up its own without
 * every row re-deriving the whole set.
 */
export function useBlockedAgents(): Record<string, BlockedAgent> {
	const panes = useTabsStore((s) => s.panes);
	const { notifications } = useAttention();

	return useMemo(() => {
		// Newest unread attention note per pane. The reason shown should be the
		// current question, not the first one ever asked.
		const newestByPane = new Map<string, { body: string; createdAt: number }>();
		for (const n of notifications) {
			if (n.kind !== "attention" || !n.paneId || n.readAt !== null) continue;
			const existing = newestByPane.get(n.paneId);
			if (!existing || n.createdAt > existing.createdAt) {
				newestByPane.set(n.paneId, {
					body: n.body || n.title,
					createdAt: n.createdAt,
				});
			}
		}

		const blocked: Record<string, BlockedAgent> = {};
		for (const pane of Object.values(panes) as Pane[]) {
			if (pane.status !== "permission") continue;
			const note = newestByPane.get(pane.id);
			blocked[pane.id] = {
				paneId: pane.id,
				workspaceId: null,
				sessionName: pane.userTitle?.trim() || pane.name,
				reason: note?.body.trim() || null,
				askedAt: note?.createdAt ?? null,
			};
		}
		return blocked;
	}, [panes, notifications]);
}
