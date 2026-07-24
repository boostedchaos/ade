/**
 * Local structural types for the Team Dashboard (issue #51, unit U6).
 *
 * These mirror the frozen `teamDashboard` tRPC router contract exactly. We keep
 * them local (rather than inferring from the router) so the renderer UI type-checks
 * independently of whether the parallel router work has landed yet.
 */

export type AgentStatus =
	| "working"
	| "waiting"
	| "blocked"
	| "idle"
	| "unknown";

export type ChecksStatus = "success" | "failure" | "pending" | "none";

export interface RosterPR {
	number: number;
	title: string;
	url: string;
	checksStatus: ChecksStatus;
}

export interface RosterEntry {
	workspaceId: string;
	name: string;
	iconUrl: string | null;
	branch: string | null;
	status: AgentStatus;
	session: { model: string | null; contextTokens: number | null } | null;
	pr: RosterPR | null;
	lastActivityAt: number | null;
}

/**
 * The GitHub-backed PR overlay for one roster entry (issue #65). Served by the
 * separate `rosterGitHub` procedure so the local roster paints before the slow
 * `gh`/`git` reads resolve, then merged onto it client-side.
 */
export interface RosterPROverlay {
	workspaceId: string;
	pr: RosterPR | null;
}

export type ActivityKind =
	| "pr-opened"
	| "pr-merged"
	| "pr-closed"
	| "issue-opened"
	| "issue-closed"
	| "mail";

export interface ActivityEvent {
	id: string;
	kind: ActivityKind;
	at: string;
	title: string;
	url: string | null;
	number: number | null;
	actor: string | null;
}

export interface BoardItem {
	number: number;
	title: string;
	url: string;
	labels: string[];
	updatedAt: string;
	agent?: { workspaceId: string; name: string; branch: string | null };
	pr?: {
		number: number;
		title: string;
		url: string;
		state: string;
		headRefName: string;
		checksStatus: ChecksStatus;
		updatedAt: string;
		mergedAt: string | null;
		body: string;
	};
}

export interface WorkBoardData {
	todo: BoardItem[];
	doing: BoardItem[];
	done: BoardItem[];
}
