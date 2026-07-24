import {
	readLatestSessionActivity,
	readLatestSessionStats,
} from "./claude-sessions";
import {
	type ActivityEvent,
	type AgentRef,
	type BoardItem,
	deriveActivityFeed,
	deriveWorkBoard,
	fetchGitHubPRStatus,
	fetchTeamGitHubSnapshot,
} from "./github-team";
import { listMailEvents } from "./mail-events";

/**
 * Team dashboard derivations (issue #51, unit U5). The single place both the
 * desktop and ade-server `teamDashboard` routers do their real work, so the
 * routers stay thin (DB row → TeamWorkspaceRef mapping only).
 *
 * HARD CONSTRAINT: import-time DB-free and Electron-free. Nothing here touches
 * the local-db or electron — callers resolve `workspaces` rows to plain strings
 * (a `TeamWorkspaceRef[]`) and hand them in.
 */

/**
 * A workspace resolved to the plain strings this module needs. Routers build
 * these from their own DB rows (desktop: getWorkspacesByProjectId; server:
 * workspaces table + resolveAgentWorktreePath + getAgentHome).
 */
export type TeamWorkspaceRef = {
	workspaceId: string;
	name: string;
	iconUrl: string | null;
	branch: string | null;
	worktreePath: string;
	agentHome: string | null;
};

export type RosterPR = {
	number: number;
	title: string;
	url: string;
	checksStatus: "success" | "failure" | "pending" | "none";
};

export type RosterEntry = {
	workspaceId: string;
	name: string;
	iconUrl: string | null;
	branch: string | null;
	status: "working" | "waiting" | "blocked" | "idle" | "unknown";
	session: { model: string | null; contextTokens: number | null } | null;
	pr: RosterPR | null;
	lastActivityAt: number | null;
};

/**
 * The GitHub-backed overlay for a single roster entry (issue #65). Returned by
 * the separate `rosterGitHub` procedure so the local roster can paint before the
 * slow `gh`/`git` spawns resolve. One entry per workspace, keyed by workspaceId.
 */
export type RosterPROverlay = {
	workspaceId: string;
	pr: RosterPR | null;
};

/**
 * Combine an agent's live-session activity with its PR checks into the roster
 * status. A failing PR ("blocked") outranks everything; otherwise the raw
 * session activity carries through. Kept as a pure, dependency-free seam so the
 * precedence is unit-testable without the async filesystem/gh reads.
 */
export function deriveRosterStatus(
	activityStatus: RosterEntry["status"],
	checksStatus: string | null,
): RosterEntry["status"] {
	if (checksStatus === "failure") return "blocked";
	return activityStatus;
}

/**
 * Build the per-agent roster from LOCAL data only (issue #65): live session
 * activity + model/context stats, both read from JSONL files on disk (fast). The
 * GitHub-backed PR column is deliberately excluded here so first paint never
 * blocks on the 10-35s `gh`/`git` spawns — that half arrives separately via
 * `buildRosterGitHub` and is merged client-side (see `applyRosterOverlay`).
 *
 * Because there's no checks data at this stage, status comes from activity alone
 * (`deriveRosterStatus(..., null)`) — an entry is never "blocked" here. Per-
 * workspace failures degrade that single entry to status "unknown"; they never
 * sink the whole roster. `pr` is always null until the overlay hydrates it.
 */
export async function buildRoster(
	workspaces: TeamWorkspaceRef[],
): Promise<RosterEntry[]> {
	return Promise.all(
		workspaces.map(async (ws): Promise<RosterEntry> => {
			try {
				const [activity, stats] = await Promise.all([
					readLatestSessionActivity(ws.worktreePath),
					readLatestSessionStats(ws.worktreePath),
				]);

				return {
					workspaceId: ws.workspaceId,
					name: ws.name,
					iconUrl: ws.iconUrl,
					branch: ws.branch,
					status: deriveRosterStatus(activity.status, null),
					session: stats
						? { model: stats.model, contextTokens: stats.contextTokens }
						: null,
					pr: null,
					lastActivityAt: activity.lastModified,
				};
			} catch {
				return {
					workspaceId: ws.workspaceId,
					name: ws.name,
					iconUrl: ws.iconUrl,
					branch: ws.branch,
					status: "unknown",
					session: null,
					pr: null,
					lastActivityAt: null,
				};
			}
		}),
	);
}

/**
 * Env-gated artificial delay (ms) applied before the roster's GitHub calls.
 * Zero unless `ADE_DASHBOARD_GH_DELAY_MS` is set to a positive integer. This
 * is the acceptance hook for issue #65 (simulate a slow-DNS network where `gh`
 * spawns take 30s) without having to touch the shared `github-team` module — it
 * lets you verify the local roster still paints in <1s while the PR overlay lags.
 */
export function rosterGitHubDelayMs(): number {
	const raw = process.env.ADE_DASHBOARD_GH_DELAY_MS;
	if (!raw) return 0;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Build the GitHub-backed PR overlay for the roster (issue #65): one
 * `RosterPROverlay` per workspace, resolved from `fetchGitHubPRStatus`. This is
 * the slow half — it's a separate procedure so `buildRoster` (local) can paint
 * first and this hydrates the PR column / blocked status when it arrives. A
 * per-workspace failure degrades that entry to `pr: null`; it never throws.
 */
export async function buildRosterGitHub(
	workspaces: TeamWorkspaceRef[],
): Promise<RosterPROverlay[]> {
	const delay = rosterGitHubDelayMs();
	if (delay > 0) {
		await new Promise((resolve) => setTimeout(resolve, delay));
	}

	return Promise.all(
		workspaces.map(async (ws): Promise<RosterPROverlay> => {
			try {
				const prStatus = await fetchGitHubPRStatus(ws.worktreePath);
				const pr = prStatus?.pr
					? {
							number: prStatus.pr.number,
							title: prStatus.pr.title,
							url: prStatus.pr.url,
							checksStatus: prStatus.pr.checksStatus,
						}
					: null;
				return { workspaceId: ws.workspaceId, pr };
			} catch {
				return { workspaceId: ws.workspaceId, pr: null };
			}
		}),
	);
}

/**
 * Merge the GitHub PR overlay onto a locally-built roster (issue #65). Pure and
 * synchronous so the precedence is unit-testable. For each entry:
 *   - if the overlay has a row for that workspace, its `pr` is applied (may be
 *     null → the agent genuinely has no PR);
 *   - `deriveRosterStatus` then recomputes status against the (possibly new)
 *     checks data, so a failing PR surfaces as "blocked" only once the overlay
 *     is present. A missing overlay row leaves the entry exactly as the local
 *     roster built it (status from activity alone — never "blocked").
 *
 * The desktop client mirrors this merge in `useTeamDashboard`; this canonical
 * version is what the server-core unit tests pin the precedence against.
 */
export function applyRosterOverlay(
	roster: RosterEntry[],
	overlay: RosterPROverlay[],
): RosterEntry[] {
	const byWorkspace = new Map<string, RosterPROverlay>();
	for (const o of overlay) byWorkspace.set(o.workspaceId, o);

	return roster.map((entry) => {
		const row = byWorkspace.get(entry.workspaceId);
		if (!row) return entry;
		return {
			...entry,
			pr: row.pr,
			status: deriveRosterStatus(entry.status, row.pr?.checksStatus ?? null),
		};
	});
}

/**
 * Build the merged activity feed: a team-wide GitHub snapshot (all workspaces
 * share one repo, so the first workspace's worktree is the repo path) plus the
 * agent-mail roll-up, folded into a time-ordered feed.
 */
export async function buildActivity(
	workspaces: TeamWorkspaceRef[],
	limit: number,
): Promise<ActivityEvent[]> {
	const repoPath = workspaces[0]?.worktreePath;
	if (!repoPath) return [];

	const homes = workspaces
		.filter((ws): ws is TeamWorkspaceRef & { agentHome: string } =>
			Boolean(ws.agentHome),
		)
		.map((ws) => ({ name: ws.name, home: ws.agentHome }));

	const [snap, mail] = await Promise.all([
		fetchTeamGitHubSnapshot(repoPath),
		listMailEvents(homes, limit),
	]);

	return deriveActivityFeed(snap, mail, limit);
}

/**
 * Build the work board (todo / doing / done) by correlating the team-wide
 * GitHub snapshot with the agents' branches.
 */
export async function buildWorkBoard(
	workspaces: TeamWorkspaceRef[],
): Promise<{ todo: BoardItem[]; doing: BoardItem[]; done: BoardItem[] }> {
	const repoPath = workspaces[0]?.worktreePath;
	if (!repoPath) return { todo: [], doing: [], done: [] };

	const snap = await fetchTeamGitHubSnapshot(repoPath);
	const agents: AgentRef[] = workspaces.map((ws) => ({
		workspaceId: ws.workspaceId,
		name: ws.name,
		branch: ws.branch,
	}));

	return deriveWorkBoard(snap, agents);
}
