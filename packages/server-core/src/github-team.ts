import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CheckItem, GitHubStatus } from "@superset/local-db";
import { z } from "zod";
import { execWithShellEnv } from "./shell-env";

/**
 * GitHub team + PR-status helpers, lifted out of the desktop app
 * (apps/desktop/src/lib/trpc/routers/workspaces/utils/github, issue #51) so the
 * same logic is shared by the desktop app and ade-server.
 *
 * Transport (issue #67): every GitHub datum is fetched in-process via Node's
 * global `fetch` against the GitHub REST v3 API. undici (Node) and Bun both pool
 * and keep-alive connections by default, so the DNS+TLS handshake is paid once
 * per server lifetime instead of once per spawned `gh`/`git ls-remote` process
 * (10-35s each on slow-DNS networks). The only remaining child processes are
 * fast, purely-local git reads (`git config`, `git rev-parse`, `git merge-base`)
 * and a single lazy `gh auth token` to obtain a credential.
 *
 * HARD CONSTRAINT: this module must be import-time DB-free and Electron-free
 * (it runs under bun on Windows). The only `@superset/local-db` reference is a
 * type-only import (erased at compile time).
 */

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Auth: one lazy `gh auth token`, cached in-process, GITHUB_TOKEN fallback.
// ---------------------------------------------------------------------------

let tokenPromise: Promise<string | null> | null = null;

/**
 * Resolves a GitHub token: `gh auth token` first (so an authenticated gh session
 * is reused), then the `GITHUB_TOKEN`/`GH_TOKEN` env var if gh is absent or not
 * signed in. Returns null when neither yields a token.
 */
async function resolveGitHubToken(): Promise<string | null> {
	try {
		const { stdout } = await execWithShellEnv("gh", ["auth", "token"], {
			timeout: 10_000,
		});
		const token = stdout.trim();
		if (token) {
			return token;
		}
	} catch {
		// gh missing or not authenticated — fall through to the env fallback.
	}
	const envToken = (
		process.env.GITHUB_TOKEN ||
		process.env.GH_TOKEN ||
		""
	).trim();
	return envToken || null;
}

/** Returns the cached token, resolving it lazily on first use. */
function getGitHubToken(): Promise<string | null> {
	if (!tokenPromise) {
		tokenPromise = resolveGitHubToken();
	}
	return tokenPromise;
}

/**
 * Clears the cached auth token. Exported so tests can reset auth state between
 * cases; also used internally to re-run `gh auth token` after a 401.
 */
export function __resetGitHubAuthCacheForTests(): void {
	tokenPromise = null;
}

// ---------------------------------------------------------------------------
// HTTP transport: in-process fetch with a single 401 token-refresh retry.
// ---------------------------------------------------------------------------

const GITHUB_USER_AGENT = "ade-dashboard";

function rawGitHubFetch(url: string, token: string): Promise<Response> {
	return fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			// GitHub requires a User-Agent on every request.
			"User-Agent": GITHUB_USER_AGENT,
		},
		// undici/Bun keep connections alive via the default global dispatcher, so
		// no explicit Agent is needed — the socket is reused across every call
		// below for the life of the process.
	});
}

/**
 * Performs an authenticated GitHub request. Returns null when no token is
 * available (degraded/empty behavior). On 401 the cached token is invalidated,
 * `gh auth token` is re-run once, and the request is retried a single time.
 */
async function githubRequest(url: string): Promise<Response | null> {
	const token = await getGitHubToken();
	if (!token) {
		return null;
	}

	let res = await rawGitHubFetch(url, token);
	if (res.status === 401) {
		// Token may be stale (rotated/expired) — drop it, re-run gh auth token
		// once, and retry the request a single time.
		try {
			await res.text();
		} catch {
			// ignore body-drain failure
		}
		__resetGitHubAuthCacheForTests();
		const retryToken = await getGitHubToken();
		if (!retryToken) {
			return null;
		}
		res = await rawGitHubFetch(url, retryToken);
	}
	return res;
}

/** GETs a URL and parses JSON, degrading to null on any failure or non-2xx. */
async function githubGetJson(url: string): Promise<unknown | null> {
	try {
		const res = await githubRequest(url);
		if (!res) {
			return null;
		}
		if (!res.ok) {
			try {
				await res.text();
			} catch {
				// ignore body-drain failure
			}
			return null;
		}
		return await res.json();
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Repo resolution: owner/repo from the local remote (no network).
// ---------------------------------------------------------------------------

export type RepoRef = {
	owner: string;
	repo: string;
	/** REST API base, e.g. https://api.github.com or https://ghe.host/api/v3. */
	apiBase: string;
	/** Canonical repo web URL, e.g. https://github.com/owner/repo. */
	htmlUrl: string;
};

/**
 * Parses a git remote URL (https, ssh, or scp-style) into owner/repo plus the
 * matching REST API base and web URL. Returns null when it can't be parsed.
 * Exported for unit tests.
 */
export function parseRepoRef(remoteUrl: string): RepoRef | null {
	const trimmed = remoteUrl.trim();
	if (!trimmed) {
		return null;
	}

	// Matches: https://host/owner/repo(.git), ssh://git@host/owner/repo(.git),
	// git@host:owner/repo(.git), with optional user@ and trailing slash/.git.
	const match = trimmed.match(
		/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/,
	);
	if (!match) {
		return null;
	}

	const host = match[1];
	const parts = match[2].split("/").filter(Boolean);
	if (parts.length < 2) {
		return null;
	}
	const owner = parts[parts.length - 2];
	const repo = parts[parts.length - 1];
	const apiBase =
		host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
	const htmlUrl = `https://${host}/${owner}/${repo}`;
	return { owner, repo, apiBase, htmlUrl };
}

/** Reads `remote.origin.url` locally and parses it to a RepoRef. */
async function getRepoRef(worktreePath: string): Promise<RepoRef | null> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", worktreePath, "config", "--get", "remote.origin.url"],
			{ timeout: 10_000 },
		);
		return parseRepoRef(stdout);
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// REST response schemas (snake_case) — kept permissive so one odd field never
// sinks a whole fetch.
// ---------------------------------------------------------------------------

const RestCheckRunSchema = z.object({
	name: z.string().nullish(),
	status: z.string().nullish(), // queued | in_progress | completed
	conclusion: z.string().nullish(), // success | failure | neutral | ...
	details_url: z.string().nullish(),
	html_url: z.string().nullish(),
});

const RestCheckRunsSchema = z.object({
	check_runs: z.array(RestCheckRunSchema).nullish(),
});

const RestCombinedStatusSchema = z.object({
	statuses: z
		.array(
			z.object({
				context: z.string().nullish(),
				state: z.string().nullish(), // success | failure | pending | error
				target_url: z.string().nullish(),
			}),
		)
		.nullish(),
});

const RestHeadSchema = z.object({ ref: z.string(), sha: z.string() });

const RestPullSchema = z.object({
	number: z.number(),
	title: z.string(),
	html_url: z.string(),
	state: z.string(), // open | closed
	draft: z.boolean().nullish(),
	merged_at: z.string().nullish(),
	body: z.string().nullish(),
	updated_at: z.string(),
	head: RestHeadSchema,
});

const RestPullDetailSchema = RestPullSchema.extend({
	additions: z.number().nullish(),
	deletions: z.number().nullish(),
});

const RestReviewSchema = z.object({
	user: z.object({ login: z.string() }).nullish(),
	state: z.string(), // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
});

const RestIssueSchema = z.object({
	number: z.number(),
	title: z.string(),
	html_url: z.string(),
	state: z.string(), // open | closed
	labels: z
		.array(z.union([z.string(), z.object({ name: z.string().nullish() })]))
		.nullish(),
	assignees: z.array(z.object({ login: z.string() })).nullish(),
	body: z.string().nullish(),
	updated_at: z.string(),
	closed_at: z.string().nullish(),
	// Present iff this "issue" is actually a pull request (REST /issues mixes them).
	pull_request: z.unknown().nullish(),
});

type RestPull = z.infer<typeof RestPullSchema>;

// ---------------------------------------------------------------------------
// Checks: REST check-runs + legacy commit statuses -> CheckItem[] + rollup.
// (This is the REST equivalent of gh's statusCheckRollup.)
// ---------------------------------------------------------------------------

function mapCheckRunStatus(
	status: string | null | undefined,
	conclusion: string | null | undefined,
): CheckItem["status"] {
	// A run that hasn't completed is still pending regardless of conclusion.
	if (status && status !== "completed") {
		return "pending";
	}
	switch (conclusion) {
		case "success":
			return "success";
		case "failure":
		case "timed_out":
		case "action_required":
		case "startup_failure":
			return "failure";
		case "cancelled":
			return "cancelled";
		case "skipped":
		case "neutral":
		case "stale":
			return "skipped";
		default:
			return "pending";
	}
}

function mapCommitStatusState(
	state: string | null | undefined,
): CheckItem["status"] {
	switch (state) {
		case "success":
			return "success";
		case "failure":
		case "error":
			return "failure";
		default:
			return "pending";
	}
}

/**
 * Normalizes a commit's check-runs response and combined-status response into a
 * flat CheckItem list (the shape the dashboard renders). Either argument may be
 * null/garbage. Exported for unit tests.
 */
export function restChecksToCheckItems(
	checkRunsJson: unknown,
	combinedStatusJson: unknown,
): CheckItem[] {
	const items: CheckItem[] = [];

	const runs = RestCheckRunsSchema.safeParse(checkRunsJson);
	if (runs.success && runs.data.check_runs) {
		for (const run of runs.data.check_runs) {
			const url = run.details_url || run.html_url || undefined;
			items.push({
				name: run.name || "Unknown check",
				status: mapCheckRunStatus(run.status, run.conclusion),
				...(url ? { url } : {}),
			});
		}
	}

	const statuses = RestCombinedStatusSchema.safeParse(combinedStatusJson);
	if (statuses.success && statuses.data.statuses) {
		for (const s of statuses.data.statuses) {
			items.push({
				name: s.context || "Unknown check",
				status: mapCommitStatusState(s.state),
				...(s.target_url ? { url: s.target_url } : {}),
			});
		}
	}

	return items;
}

/**
 * Rolls a CheckItem list up into the single-word status the UI uses:
 * failure > pending > success, or "none" when there are no checks. skipped and
 * cancelled items count as neither failure nor pending. Exported for unit tests.
 */
export function checksStatusFromItems(
	items: CheckItem[],
): "success" | "failure" | "pending" | "none" {
	if (items.length === 0) {
		return "none";
	}
	let hasFailure = false;
	let hasPending = false;
	for (const item of items) {
		if (item.status === "failure") {
			hasFailure = true;
		} else if (item.status === "pending") {
			hasPending = true;
		}
	}
	if (hasFailure) {
		return "failure";
	}
	if (hasPending) {
		return "pending";
	}
	return "success";
}

/** Fetches check-runs + combined statuses for a commit and normalizes them. */
async function fetchCheckItems(
	ref: RepoRef,
	sha: string,
): Promise<CheckItem[]> {
	const base = `${ref.apiBase}/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(sha)}`;
	const [runsJson, statusJson] = await Promise.all([
		githubGetJson(`${base}/check-runs?per_page=100`),
		githubGetJson(`${base}/status?per_page=100`),
	]);
	return restChecksToCheckItems(runsJson, statusJson);
}

// ---------------------------------------------------------------------------
// Per-worktree PR status (fetchGitHubPRStatus)
// ---------------------------------------------------------------------------

const cache = new Map<string, { data: GitHubStatus; timestamp: number }>();
// 2.5min: even in-process fetches age gracefully here. Roster's local
// (session-activity) half stays live; only the PR column ages.
const CACHE_TTL_MS = 150_000;

/**
 * Fetches GitHub PR status for a worktree via the REST API.
 * Returns null if the remote can't be resolved, there's no token, or on error.
 */
export async function fetchGitHubPRStatus(
	worktreePath: string,
): Promise<GitHubStatus | null> {
	const cached = cache.get(worktreePath);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return cached.data;
	}

	const started = Date.now();
	try {
		const ref = await getRepoRef(worktreePath);
		if (!ref) {
			return null;
		}

		const { stdout: branchOutput } = await execFileAsync(
			"git",
			["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"],
			{ timeout: 10_000 },
		);
		const branchName = branchOutput.trim();

		const [branchExists, prInfo] = await Promise.all([
			branchExistsOnRemote(ref, branchName),
			getPRForBranch(ref, worktreePath, branchName),
		]);

		const result: GitHubStatus = {
			pr: prInfo,
			repoUrl: ref.htmlUrl,
			branchExistsOnRemote: branchExists,
			lastRefreshed: Date.now(),
		};

		cache.set(worktreePath, { data: result, timestamp: Date.now() });
		return result;
	} catch {
		return null;
	} finally {
		if (process.env.ADE_GH_TIMING) {
			console.log(
				`[github-team] fetchGitHubPRStatus(${worktreePath}) ${Date.now() - started}ms`,
			);
		}
	}
}

/**
 * Returns true if `branchName` exists on origin via
 * `GET /repos/{owner}/{repo}/branches/{branch}` (200 = yes, 404 = no). Any
 * failure degrades to false.
 */
async function branchExistsOnRemote(
	ref: RepoRef,
	branchName: string,
): Promise<boolean> {
	try {
		// Branch names contain literal slashes; the API wants them unencoded.
		const url = `${ref.apiBase}/repos/${ref.owner}/${ref.repo}/branches/${branchName}`;
		const res = await githubRequest(url);
		if (!res) {
			return false;
		}
		const exists = res.status === 200;
		try {
			await res.text(); // drain so the socket returns to the keep-alive pool
		} catch {
			// ignore
		}
		return exists;
	} catch {
		return false;
	}
}

/**
 * Finds the PR for a branch via
 * `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all`, then keeps
 * only a candidate whose head commit shares ancestry with local HEAD.
 */
async function getPRForBranch(
	ref: RepoRef,
	worktreePath: string,
	branchName: string,
): Promise<GitHubStatus["pr"]> {
	const headParam = encodeURIComponent(`${ref.owner}:${branchName}`);
	const url = `${ref.apiBase}/repos/${ref.owner}/${ref.repo}/pulls?head=${headParam}&state=all&per_page=20`;
	const json = await githubGetJson(url);
	if (!Array.isArray(json)) {
		return null;
	}

	const candidates: RestPull[] = [];
	for (const item of json) {
		const parsed = RestPullSchema.safeParse(item);
		if (parsed.success) {
			candidates.push(parsed.data);
		}
	}
	// Prefer the most recent PR when a branch has been reused.
	candidates.sort((a, b) => b.number - a.number);

	for (const candidate of candidates) {
		if (await sharesAncestry(worktreePath, candidate.head.sha)) {
			return buildWorktreePR(ref, candidate);
		}
	}
	return null;
}

/**
 * Enriches a PR list item with the detail (additions/deletions), review
 * decision, and check rollup needed for the worktree PR shape.
 */
async function buildWorktreePR(
	ref: RepoRef,
	pull: RestPull,
): Promise<NonNullable<GitHubStatus["pr"]>> {
	const prBase = `${ref.apiBase}/repos/${ref.owner}/${ref.repo}/pulls/${pull.number}`;
	const [detailJson, reviewsJson, checks] = await Promise.all([
		githubGetJson(prBase),
		githubGetJson(`${prBase}/reviews?per_page=100`),
		fetchCheckItems(ref, pull.head.sha),
	]);

	const detail = RestPullDetailSchema.safeParse(detailJson);
	const additions = detail.success ? (detail.data.additions ?? 0) : 0;
	const deletions = detail.success ? (detail.data.deletions ?? 0) : 0;

	return formatWorktreePR(
		pull,
		additions,
		deletions,
		computeReviewDecision(reviewsJson),
		checks,
	);
}

/**
 * Builds the worktree PR shape from its REST pieces. Exported for unit tests.
 */
export function formatWorktreePR(
	pull: RestPull,
	additions: number,
	deletions: number,
	reviewDecision: NonNullable<GitHubStatus["pr"]>["reviewDecision"],
	checks: CheckItem[],
): NonNullable<GitHubStatus["pr"]> {
	return {
		number: pull.number,
		title: pull.title,
		url: pull.html_url,
		state: mapWorktreePRState(pull),
		mergedAt: pull.merged_at ? new Date(pull.merged_at).getTime() : undefined,
		additions,
		deletions,
		reviewDecision,
		checksStatus: checksStatusFromItems(checks),
		checks,
	};
}

function mapWorktreePRState(
	pull: RestPull,
): NonNullable<GitHubStatus["pr"]>["state"] {
	if (pull.merged_at) return "merged";
	if (pull.state === "closed") return "closed";
	if (pull.draft) return "draft";
	return "open";
}

/**
 * Reduces a PR's REST reviews to a gh-equivalent reviewDecision. Takes each
 * reviewer's latest decisive review (ignoring COMMENTED/PENDING); any
 * CHANGES_REQUESTED wins, else any APPROVED, else pending. Exported for tests.
 */
export function computeReviewDecision(
	reviewsJson: unknown,
): NonNullable<GitHubStatus["pr"]>["reviewDecision"] {
	if (!Array.isArray(reviewsJson)) {
		return "pending";
	}
	// Reviews arrive chronologically; a later review overwrites an earlier one.
	const latestByUser = new Map<string, string>();
	for (const raw of reviewsJson) {
		const parsed = RestReviewSchema.safeParse(raw);
		if (!parsed.success) {
			continue;
		}
		const login = parsed.data.user?.login;
		const state = parsed.data.state;
		if (!login || state === "COMMENTED" || state === "PENDING") {
			continue;
		}
		latestByUser.set(login, state);
	}
	for (const state of latestByUser.values()) {
		if (state === "CHANGES_REQUESTED") {
			return "changes_requested";
		}
	}
	for (const state of latestByUser.values()) {
		if (state === "APPROVED") {
			return "approved";
		}
	}
	return "pending";
}

/**
 * Returns true if local HEAD and the given commit share ancestry
 * (one is an ancestor of the other, or they are the same commit). Local git
 * only — no network fallback.
 */
async function sharesAncestry(
	worktreePath: string,
	prHeadOid: string,
): Promise<boolean> {
	try {
		const { stdout: localHead } = await execFileAsync(
			"git",
			["-C", worktreePath, "rev-parse", "HEAD"],
			{ timeout: 10_000 },
		);
		const localOid = localHead.trim();

		if (localOid === prHeadOid) {
			return true;
		}

		for (const [ancestor, descendant] of [
			[prHeadOid, localOid],
			[localOid, prHeadOid],
		]) {
			try {
				await execFileAsync(
					"git",
					[
						"-C",
						worktreePath,
						"merge-base",
						"--is-ancestor",
						ancestor,
						descendant,
					],
					{ timeout: 10_000 },
				);
				return true;
			} catch {
				// Try the other direction.
			}
		}

		return false;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Team dashboard snapshot + derivations (issue #51, unit U2)
// ---------------------------------------------------------------------------

export type TeamGitHubSnapshot = {
	issues: Array<{
		number: number;
		title: string;
		url: string;
		state: "open" | "closed";
		labels: string[];
		assignees: string[];
		body: string;
		updatedAt: string;
		closedAt: string | null;
	}>;
	prs: Array<{
		number: number;
		title: string;
		url: string;
		state: "open" | "merged" | "closed";
		headRefName: string;
		body: string;
		checksStatus: "success" | "failure" | "pending" | "none";
		updatedAt: string;
		mergedAt: string | null;
	}>;
};

export type AgentRef = {
	workspaceId: string;
	name: string;
	branch: string | null;
};

export type BoardItem = {
	number: number;
	title: string;
	url: string;
	labels: string[];
	updatedAt: string;
	agent?: AgentRef;
	pr?: TeamGitHubSnapshot["prs"][number];
};

export type ActivityEvent = {
	id: string;
	kind:
		| "pr-opened"
		| "pr-merged"
		| "pr-closed"
		| "issue-opened"
		| "issue-closed"
		| "mail";
	at: string;
	title: string;
	url: string | null;
	number: number | null;
	actor: string | null;
};

/**
 * Canonical home for the mail-event shape (frozen contract). The team dashboard's
 * mail-events unit imports this type from here rather than redefining it.
 */
export type MailEvent = {
	id: string;
	thread: string;
	from: string;
	to: string;
	status: string;
	at: string;
	subjectLine: string;
};

/**
 * Maps a REST /issues item to the snapshot issue shape, or null if it's actually
 * a PR (the /issues endpoint mixes them) or unparseable. Exported for tests.
 */
export function mapRestIssueToTeam(
	raw: unknown,
): TeamGitHubSnapshot["issues"][number] | null {
	const parsed = RestIssueSchema.safeParse(raw);
	if (!parsed.success) {
		return null;
	}
	const data = parsed.data;
	// The /issues endpoint returns PRs too — skip anything with a pull_request key.
	if (data.pull_request) {
		return null;
	}
	return {
		number: data.number,
		title: data.title,
		url: data.html_url,
		state: data.state === "closed" ? "closed" : "open",
		labels: (data.labels ?? [])
			.map((l) => (typeof l === "string" ? l : (l.name ?? "")))
			.filter((n): n is string => n.length > 0),
		assignees: (data.assignees ?? []).map((a) => a.login),
		body: data.body ?? "",
		updatedAt: data.updated_at,
		closedAt: data.closed_at ?? null,
	};
}

/**
 * Maps a REST /pulls item plus its resolved checks status to the snapshot PR
 * shape, or null if unparseable. Exported for tests.
 */
export function mapRestPRToTeam(
	raw: unknown,
	checksStatus: TeamGitHubSnapshot["prs"][number]["checksStatus"],
): TeamGitHubSnapshot["prs"][number] | null {
	const parsed = RestPullSchema.safeParse(raw);
	if (!parsed.success) {
		return null;
	}
	const data = parsed.data;
	return {
		number: data.number,
		title: data.title,
		url: data.html_url,
		state: normalizeTeamPRState(data.state, data.merged_at ?? null),
		headRefName: data.head.ref,
		body: data.body ?? "",
		checksStatus,
		updatedAt: data.updated_at,
		mergedAt: data.merged_at ?? null,
	};
}

/**
 * Fetches an org/repo-wide snapshot of issues + PRs for the team dashboard via
 * the REST API (all fetches keep-alive over one connection).
 *
 * NEVER throws: unresolvable remote, no token, or any parse error all degrade to
 * `{ issues: [], prs: [] }`.
 *
 * This is the transport-side boundary (issue #67). `fetchTeamGitHubSnapshot`
 * below is the cached, public entry point (issue #66) — keep the cache wrapped
 * around this function rather than folded into it, so the two stay composable.
 */
async function fetchTeamGitHubSnapshotUncached(
	repoPath: string,
): Promise<TeamGitHubSnapshot> {
	const started = Date.now();
	try {
		const ref = await getRepoRef(repoPath);
		if (!ref) {
			return { issues: [], prs: [] };
		}
		const [issues, prs] = await Promise.all([
			fetchTeamIssues(ref),
			fetchTeamPRs(ref),
		]);
		return { issues, prs };
	} catch {
		return { issues: [], prs: [] };
	} finally {
		if (process.env.ADE_GH_TIMING) {
			console.log(
				`[github-team] fetchTeamGitHubSnapshot(${repoPath}) ${Date.now() - started}ms`,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Per-repoPath cache for fetchTeamGitHubSnapshot (issue #66), stale-while-
// revalidate with single-flight refresh dedupe. Same shape as the
// fetchGitHubPRStatus cache above, same TTL (af80ddc): activity(15s) and
// board(30s) dashboard polls both call this per cycle, so without a shared
// cache every cycle spawns up to 4 `gh` processes costing 10-35s each on
// slow-DNS networks.
const snapshotCache = new Map<
	string,
	{ data: TeamGitHubSnapshot; timestamp: number }
>();
const snapshotRefreshes = new Map<string, Promise<TeamGitHubSnapshot>>();
const SNAPSHOT_CACHE_TTL_MS = 150_000;

/**
 * Kicks (or reuses) a single in-flight refresh for `key`. On success the
 * cache entry is updated; on failure the cache is left untouched, so a
 * stale read served alongside a failed refresh just keeps being stale until
 * a later refresh succeeds. Exported (not just internal) so the caching
 * behavior itself — dedupe, stale-serving, refresh failure — can be unit
 * tested with an injected fetcher, without needing to mock `gh`.
 */
export function refreshTeamGitHubSnapshotCache(
	key: string,
	fetcher: (key: string) => Promise<TeamGitHubSnapshot> = fetchTeamGitHubSnapshotUncached,
): Promise<TeamGitHubSnapshot> {
	const inflight = snapshotRefreshes.get(key);
	if (inflight) {
		return inflight;
	}
	const promise = fetcher(key)
		.then((data) => {
			snapshotCache.set(key, { data, timestamp: Date.now() });
			return data;
		})
		.finally(() => {
			snapshotRefreshes.delete(key);
		});
	snapshotRefreshes.set(key, promise);
	return promise;
}

/** Test-only: clears the module-level snapshot cache between test cases. */
export function clearTeamGitHubSnapshotCache(): void {
	snapshotCache.clear();
	snapshotRefreshes.clear();
}

/**
 * Test-only: seeds the cache with `data` at a given age, so tests can put an
 * entry past `SNAPSHOT_CACHE_TTL_MS` without waiting 150 real seconds.
 */
export function seedTeamGitHubSnapshotCacheForTest(
	key: string,
	data: TeamGitHubSnapshot,
	ageMs: number,
): void {
	snapshotCache.set(key, { data, timestamp: Date.now() - ageMs });
}

/**
 * Cached, stale-while-revalidate entry point for the team dashboard snapshot.
 * First-ever call (no cache) awaits the live fetch. A hit within the TTL
 * returns the cached snapshot without spawning anything. An expired entry is
 * returned immediately while a single background refresh is kicked off
 * (concurrent callers share it); a failed refresh just leaves the stale
 * entry in place for the next attempt.
 */
export async function fetchTeamGitHubSnapshot(
	repoPath: string,
): Promise<TeamGitHubSnapshot> {
	const cached = snapshotCache.get(repoPath);
	if (!cached) {
		return refreshTeamGitHubSnapshotCache(repoPath);
	}
	if (Date.now() - cached.timestamp < SNAPSHOT_CACHE_TTL_MS) {
		return cached.data;
	}
	// Stale: serve immediately, refresh in the background (single-flight).
	// Nobody awaits this, so a rejection here is intentionally swallowed —
	// the stale value returned above keeps being served until a refresh
	// succeeds.
	refreshTeamGitHubSnapshotCache(repoPath).catch(() => {});
	return cached.data;
}

async function fetchTeamIssues(
	ref: RepoRef,
): Promise<TeamGitHubSnapshot["issues"]> {
	const url = `${ref.apiBase}/repos/${ref.owner}/${ref.repo}/issues?state=all&per_page=100`;
	const json = await githubGetJson(url);
	if (!Array.isArray(json)) {
		return [];
	}
	const issues: TeamGitHubSnapshot["issues"] = [];
	for (const item of json) {
		const mapped = mapRestIssueToTeam(item);
		if (mapped) {
			issues.push(mapped);
		}
	}
	return issues;
}

async function fetchTeamPRs(ref: RepoRef): Promise<TeamGitHubSnapshot["prs"]> {
	const url = `${ref.apiBase}/repos/${ref.owner}/${ref.repo}/pulls?state=all&per_page=50`;
	const json = await githubGetJson(url);
	if (!Array.isArray(json)) {
		return [];
	}

	const pulls: RestPull[] = [];
	for (const item of json) {
		const parsed = RestPullSchema.safeParse(item);
		if (parsed.success) {
			pulls.push(parsed.data);
		}
	}

	// Only OPEN PRs render their check status on the board; skip the per-PR
	// check-runs round trips for closed/merged PRs to stay within the fetch budget.
	const checksByNumber = new Map<
		number,
		TeamGitHubSnapshot["prs"][number]["checksStatus"]
	>();
	await Promise.all(
		pulls
			.filter((p) => p.state === "open" && !p.merged_at)
			.map(async (p) => {
				const items = await fetchCheckItems(ref, p.head.sha);
				checksByNumber.set(p.number, checksStatusFromItems(items));
			}),
	);

	const prs: TeamGitHubSnapshot["prs"] = [];
	for (const pull of pulls) {
		const mapped = mapRestPRToTeam(
			pull,
			checksByNumber.get(pull.number) ?? "none",
		);
		if (mapped) {
			prs.push(mapped);
		}
	}
	return prs;
}

function normalizeTeamPRState(
	state: string,
	mergedAt: string | null,
): TeamGitHubSnapshot["prs"][number]["state"] {
	const lower = state.toLowerCase();
	if (lower === "merged" || mergedAt) return "merged";
	if (lower === "closed") return "closed";
	return "open";
}

// Extracts an issue-like number from a branch/ref name. Matches a run of digits
// bounded by a separator or the string edge, optionally prefixed with `#`.
// e.g. "feat/issue-51-team-dashboard" -> {51}, "fix-12" -> {12}.
const BRANCH_NUMBER_RE = /(?:^|[-/_])#?(\d+)(?:[-_/]|$)/g;

function extractBranchNumbers(branch: string): Set<number> {
	const nums = new Set<number>();
	BRANCH_NUMBER_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((match = BRANCH_NUMBER_RE.exec(branch)) !== null) {
		nums.add(Number.parseInt(match[1], 10));
		// Guard against zero-width matches locking the loop.
		if (match.index === BRANCH_NUMBER_RE.lastIndex) {
			BRANCH_NUMBER_RE.lastIndex++;
		}
	}
	return nums;
}

// True if `#<number>` appears in the text as a whole token (so #51 does not match
// #510 or #515).
function mentionsIssue(text: string, issueNumber: number): boolean {
	return new RegExp(`#${issueNumber}(?![0-9])`).test(text);
}

function sortByUpdatedAtDesc<T extends { updatedAt: string }>(items: T[]): T[] {
	return [...items].sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt));
}

function toTime(value: string | null): number {
	if (!value) return 0;
	const t = Date.parse(value);
	return Number.isNaN(t) ? 0 : t;
}

/**
 * Derives the three work-board columns (pure, synchronous).
 *
 * - `done`  = closed issues.
 * - `doing` = open issues correlated with work-in-flight via any of:
 *     (a) an OPEN PR whose headRefName encodes the issue number,
 *     (b) `#N` appearing in an OPEN PR's title or body,
 *     (c) an agent whose branch encodes the issue number.
 *   The matching PR and/or agent is attached to the board item.
 * - `todo`  = remaining open issues.
 *
 * Each column is sorted by `updatedAt` descending.
 */
export function deriveWorkBoard(
	snap: TeamGitHubSnapshot,
	agents: AgentRef[],
): { todo: BoardItem[]; doing: BoardItem[]; done: BoardItem[] } {
	const openPRs = snap.prs.filter((pr) => pr.state === "open");

	const done: BoardItem[] = [];
	const doing: BoardItem[] = [];
	const todo: BoardItem[] = [];

	for (const issue of snap.issues) {
		const base: BoardItem = {
			number: issue.number,
			title: issue.title,
			url: issue.url,
			labels: issue.labels,
			updatedAt: issue.updatedAt,
		};

		if (issue.state === "closed") {
			done.push(base);
			continue;
		}

		// (a) + (b): correlate against open PRs.
		const matchingPr = openPRs.find(
			(pr) =>
				extractBranchNumbers(pr.headRefName).has(issue.number) ||
				mentionsIssue(pr.title, issue.number) ||
				mentionsIssue(pr.body, issue.number),
		);

		// (c): correlate against agent branches.
		const matchingAgent = agents.find(
			(agent) =>
				agent.branch != null &&
				extractBranchNumbers(agent.branch).has(issue.number),
		);

		if (matchingPr || matchingAgent) {
			doing.push({
				...base,
				...(matchingPr ? { pr: matchingPr } : {}),
				...(matchingAgent ? { agent: matchingAgent } : {}),
			});
		} else {
			todo.push(base);
		}
	}

	return {
		todo: sortByUpdatedAtDesc(todo),
		doing: sortByUpdatedAtDesc(doing),
		done: sortByUpdatedAtDesc(done),
	};
}

/**
 * Derives a merged, time-ordered activity feed (pure, synchronous).
 *
 * PRs: open -> pr-opened @updatedAt; merged -> pr-merged @mergedAt;
 * closed-unmerged -> pr-closed @updatedAt.
 * Issues: open -> issue-opened @updatedAt; closed -> issue-closed @closedAt
 * (falling back to updatedAt).
 * Mail: kind "mail", title = subjectLine, actor = from.
 *
 * Events are merged, sorted by `at` descending, and truncated to `limit`.
 */
export function deriveActivityFeed(
	snap: TeamGitHubSnapshot,
	mail: MailEvent[],
	limit: number,
): ActivityEvent[] {
	const events: ActivityEvent[] = [];

	for (const pr of snap.prs) {
		if (pr.state === "merged") {
			events.push({
				id: `pr-merged-${pr.number}`,
				kind: "pr-merged",
				at: pr.mergedAt ?? pr.updatedAt,
				title: pr.title,
				url: pr.url,
				number: pr.number,
				actor: null,
			});
		} else if (pr.state === "closed") {
			events.push({
				id: `pr-closed-${pr.number}`,
				kind: "pr-closed",
				at: pr.updatedAt,
				title: pr.title,
				url: pr.url,
				number: pr.number,
				actor: null,
			});
		} else {
			events.push({
				id: `pr-opened-${pr.number}`,
				kind: "pr-opened",
				at: pr.updatedAt,
				title: pr.title,
				url: pr.url,
				number: pr.number,
				actor: null,
			});
		}
	}

	for (const issue of snap.issues) {
		if (issue.state === "closed") {
			events.push({
				id: `issue-closed-${issue.number}`,
				kind: "issue-closed",
				at: issue.closedAt ?? issue.updatedAt,
				title: issue.title,
				url: issue.url,
				number: issue.number,
				actor: null,
			});
		} else {
			events.push({
				id: `issue-opened-${issue.number}`,
				kind: "issue-opened",
				at: issue.updatedAt,
				title: issue.title,
				url: issue.url,
				number: issue.number,
				actor: null,
			});
		}
	}

	for (const m of mail) {
		events.push({
			id: m.id,
			kind: "mail",
			at: m.at,
			title: m.subjectLine,
			url: null,
			number: null,
			actor: m.from,
		});
	}

	events.sort((a, b) => toTime(b.at) - toTime(a.at));
	return events.slice(0, Math.max(0, limit));
}
