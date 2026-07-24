import { useMemo } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs";
import { getHighestPriorityStatus, type PaneStatus } from "shared/tabs-types";
import type {
	ActivityEvent,
	AgentStatus,
	RosterEntry,
	RosterPROverlay,
	WorkBoardData,
} from "./types";

/** Poll cadences (issue #51). Roster is the "live" surface, so it refreshes the
 * fastest; the board changes slowly, so it refreshes the slowest. */
const ROSTER_POLL_MS = 5_000;
/** The GitHub PR overlay (issue #65) is the slow half — gated by the 2.5min
 * server-side cache anyway — so it polls much slower than the live local roster. */
const ROSTER_GITHUB_POLL_MS = 30_000;
const ACTIVITY_POLL_MS = 15_000;
const WORKBOARD_POLL_MS = 30_000;

const EMPTY_BOARD: WorkBoardData = { todo: [], doing: [], done: [] };

/**
 * Data hook for the Team Dashboard.
 *
 * Wraps the three `teamDashboard` queries with react-query polling and applies a
 * client-side status overlay: when an agent's workspace has an open tab whose
 * live pane status is more current than the (slower-polling) server roster, we
 * override the server-reported status.
 *
 * Overlay mapping (pane status -> agent status):
 *   - pane "permission" -> "waiting"  (agent is blocked on user input)
 *   - pane "working"    -> "working"
 * Server "blocked" ALWAYS wins over the overlay (a CI/PR failure the local pane
 * has no knowledge of). "review"/"idle" panes never override the server status.
 *
 * First paint never blocks on GitHub (issue #65): the `roster` query is local
 * only (session activity/stats from disk) and drives RosterHero immediately. The
 * slower `rosterGitHub` query fills in the PR column / blocked status when it
 * resolves — a missing overlay leaves an entry's status from activity alone.
 */
export function useTeamDashboard(projectId: string) {
	const rosterQuery = electronTrpc.teamDashboard.roster.useQuery(
		{ projectId },
		{ enabled: !!projectId, refetchInterval: ROSTER_POLL_MS },
	);
	const rosterGitHubQuery = electronTrpc.teamDashboard.rosterGitHub.useQuery(
		{ projectId },
		{ enabled: !!projectId, refetchInterval: ROSTER_GITHUB_POLL_MS },
	);
	const activityQuery = electronTrpc.teamDashboard.activity.useQuery(
		{ projectId, limit: 30 },
		{ enabled: !!projectId, refetchInterval: ACTIVITY_POLL_MS },
	);
	const workBoardQuery = electronTrpc.teamDashboard.workBoard.useQuery(
		{ projectId },
		{ enabled: !!projectId, refetchInterval: WORKBOARD_POLL_MS },
	);

	// Live pane statuses come from the tabs store. Panes map to workspaces via
	// their tab: pane.tabId -> tab.id -> tab.workspaceId.
	const tabs = useTabsStore((s) => s.tabs);
	const panes = useTabsStore((s) => s.panes);

	const overlayByWorkspace = useMemo(() => {
		const tabToWorkspace = new Map<string, string>();
		for (const tab of tabs) tabToWorkspace.set(tab.id, tab.workspaceId);

		const statusesByWorkspace = new Map<
			string,
			(PaneStatus | undefined)[]
		>();
		for (const pane of Object.values(panes)) {
			const workspaceId = tabToWorkspace.get(pane.tabId);
			if (!workspaceId) continue;
			const list = statusesByWorkspace.get(workspaceId) ?? [];
			list.push(pane.status);
			statusesByWorkspace.set(workspaceId, list);
		}

		const overlay = new Map<string, AgentStatus>();
		for (const [workspaceId, statuses] of statusesByWorkspace) {
			const highest = getHighestPriorityStatus(statuses);
			if (highest === "permission") overlay.set(workspaceId, "waiting");
			else if (highest === "working") overlay.set(workspaceId, "working");
		}
		return overlay;
	}, [tabs, panes]);

	// GitHub PR overlay (issue #65), keyed by workspace. Mirrors server-core's
	// pure `applyRosterOverlay`: when a row is present its PR is applied and a
	// failing check surfaces as "blocked"; a missing row leaves the entry as the
	// local roster built it (status from activity alone, never "blocked").
	const prByWorkspace = useMemo(() => {
		const map = new Map<string, RosterPROverlay>();
		for (const row of (rosterGitHubQuery.data ?? []) as RosterPROverlay[]) {
			map.set(row.workspaceId, row);
		}
		return map;
	}, [rosterGitHubQuery.data]);

	const roster = useMemo<RosterEntry[]>(() => {
		const entries = (rosterQuery.data ?? []) as RosterEntry[];
		return entries.map((entry) => {
			// 1. GitHub PR overlay. Only a present row changes the entry; a failing
			//    PR is the sole source of "blocked".
			const overlay = prByWorkspace.get(entry.workspaceId);
			const withPr: RosterEntry = overlay
				? {
						...entry,
						pr: overlay.pr,
						status:
							overlay.pr?.checksStatus === "failure" ? "blocked" : entry.status,
					}
				: entry;

			// 2. Live pane-status overlay. Server/GitHub "blocked" always wins.
			if (withPr.status === "blocked") return withPr;
			const override = overlayByWorkspace.get(entry.workspaceId);
			if (!override) return withPr;
			return { ...withPr, status: override };
		});
	}, [rosterQuery.data, prByWorkspace, overlayByWorkspace]);

	const activity = (activityQuery.data ?? []) as ActivityEvent[];
	const board = (workBoardQuery.data ?? EMPTY_BOARD) as WorkBoardData;

	return {
		roster,
		activity,
		board,
		isRosterLoading: rosterQuery.isLoading,
		// The PR column is still pending until the GitHub overlay first resolves —
		// AgentCard uses this to reserve the PR slot (no layout shift on hydrate).
		isRosterGitHubLoading: rosterGitHubQuery.isLoading,
		isActivityLoading: activityQuery.isLoading,
		isBoardLoading: workBoardQuery.isLoading,
	};
}
