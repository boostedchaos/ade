/**
 * Renderer's read side of agent progress (Mission Control Feature 5).
 *
 * Same construction as `useAttention` next door: one query, one subscription
 * mounted once, React Query dedupes so a strip on every pane is still a single
 * read. Deliberately not a zustand store — this is main-owned state, and a
 * renderer copy of it could disagree with the registry.
 */
import { electronTrpc } from "renderer/lib/electron-trpc";

const EMPTY: Record<string, number> = {};

/** paneId → 0-100 for every pane currently reporting. */
export function useAgentProgressByPane(): Record<string, number> {
	const { data } = electronTrpc.agentSessions.list.useQuery(undefined, {
		// Refetching is driven by useAgentSessionsSync's invalidation. Progress
		// moves only when an agent calls `ade set-progress`, so a poll would spend
		// a query per interval to learn nothing.
		staleTime: Number.POSITIVE_INFINITY,
	});
	return data?.progressByPane ?? EMPTY;
}

/**
 * Progress for one pane, or null when it is not reporting.
 *
 * Null and 0 are different and both are meaningful: null draws no strip, 0
 * draws an empty one. Returning `?? 0` here would erase that distinction and
 * put an empty bar on every idle pane in the window.
 */
export function useAgentProgress(paneId: string): number | null {
	const byPane = useAgentProgressByPane();
	return byPane[paneId] ?? null;
}

/** Mount ONCE (authenticated layout), beside useAttentionSync. */
export function useAgentSessionsSync(): void {
	const utils = electronTrpc.useUtils();
	electronTrpc.agentSessions.changed.useSubscription(undefined, {
		onData: () => {
			void utils.agentSessions.list.invalidate();
		},
		onError: (error) => {
			console.error("[agent-sessions] subscription error:", error);
		},
	});
}
