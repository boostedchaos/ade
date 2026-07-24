import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentRef,
	checksStatusFromItems,
	clearTeamGitHubSnapshotCache,
	computeReviewDecision,
	deriveActivityFeed,
	deriveWorkBoard,
	fetchTeamGitHubSnapshot,
	formatWorktreePR,
	type MailEvent,
	mapRestIssueToTeam,
	mapRestPRToTeam,
	parseRepoRef,
	refreshTeamGitHubSnapshotCache,
	restChecksToCheckItems,
	seedTeamGitHubSnapshotCacheForTest,
	type TeamGitHubSnapshot,
} from "./github-team";

const SNAPSHOT_CACHE_TTL_MS = 150_000;

function issue(
	over: Partial<TeamGitHubSnapshot["issues"][number]> &
		Pick<TeamGitHubSnapshot["issues"][number], "number">,
): TeamGitHubSnapshot["issues"][number] {
	return {
		number: over.number,
		title: over.title ?? `Issue ${over.number}`,
		url: over.url ?? `https://gh/i/${over.number}`,
		state: over.state ?? "open",
		labels: over.labels ?? [],
		assignees: over.assignees ?? [],
		body: over.body ?? "",
		updatedAt: over.updatedAt ?? "2026-01-01T00:00:00Z",
		closedAt: over.closedAt ?? null,
	};
}

function pr(
	over: Partial<TeamGitHubSnapshot["prs"][number]> &
		Pick<TeamGitHubSnapshot["prs"][number], "number">,
): TeamGitHubSnapshot["prs"][number] {
	return {
		number: over.number,
		title: over.title ?? `PR ${over.number}`,
		url: over.url ?? `https://gh/p/${over.number}`,
		state: over.state ?? "open",
		headRefName: over.headRefName ?? `branch-${over.number}`,
		body: over.body ?? "",
		checksStatus: over.checksStatus ?? "none",
		updatedAt: over.updatedAt ?? "2026-01-01T00:00:00Z",
		mergedAt: over.mergedAt ?? null,
	};
}

describe("deriveWorkBoard", () => {
	it("puts closed issues in done", () => {
		const snap: TeamGitHubSnapshot = {
			issues: [issue({ number: 1, state: "closed" })],
			prs: [],
		};
		const board = deriveWorkBoard(snap, []);
		expect(board.done.map((i) => i.number)).toEqual([1]);
		expect(board.doing).toHaveLength(0);
		expect(board.todo).toHaveLength(0);
	});

	it("correlation (a): open PR headRefName encodes the issue number", () => {
		const snap: TeamGitHubSnapshot = {
			issues: [issue({ number: 51 })],
			prs: [
				pr({
					number: 9,
					state: "open",
					headRefName: "feat/issue-51-team-dashboard",
				}),
			],
		};
		const board = deriveWorkBoard(snap, []);
		expect(board.doing.map((i) => i.number)).toEqual([51]);
		expect(board.doing[0].pr?.number).toBe(9);
		expect(board.todo).toHaveLength(0);
	});

	it("correlation (b): #N in an open PR's title or body", () => {
		const snap: TeamGitHubSnapshot = {
			issues: [issue({ number: 42 }), issue({ number: 7 })],
			prs: [
				pr({
					number: 3,
					state: "open",
					headRefName: "misc",
					body: "Closes #42",
				}),
				pr({
					number: 4,
					state: "open",
					headRefName: "misc2",
					title: "Fixes #7 finally",
				}),
			],
		};
		const board = deriveWorkBoard(snap, []);
		expect(board.doing.map((i) => i.number).sort((a, b) => a - b)).toEqual([
			7, 42,
		]);
	});

	it("does not false-match #51 against #510", () => {
		const snap: TeamGitHubSnapshot = {
			issues: [issue({ number: 51 })],
			prs: [
				pr({ number: 3, state: "open", headRefName: "misc", body: "see #510" }),
			],
		};
		const board = deriveWorkBoard(snap, []);
		expect(board.todo.map((i) => i.number)).toEqual([51]);
		expect(board.doing).toHaveLength(0);
	});

	it("ignores correlation against non-open PRs", () => {
		const snap: TeamGitHubSnapshot = {
			issues: [issue({ number: 51 })],
			prs: [pr({ number: 9, state: "merged", headRefName: "feat/issue-51" })],
		};
		const board = deriveWorkBoard(snap, []);
		expect(board.todo.map((i) => i.number)).toEqual([51]);
		expect(board.doing).toHaveLength(0);
	});

	it("correlation (c): an agent branch encodes the issue number", () => {
		const snap: TeamGitHubSnapshot = {
			issues: [issue({ number: 51 })],
			prs: [],
		};
		const agents: AgentRef[] = [
			{
				workspaceId: "ws1",
				name: "Ada",
				branch: "feat/issue-51-team-dashboard",
			},
			{ workspaceId: "ws2", name: "Bob", branch: null },
		];
		const board = deriveWorkBoard(snap, agents);
		expect(board.doing.map((i) => i.number)).toEqual([51]);
		expect(board.doing[0].agent?.name).toBe("Ada");
		expect(board.doing[0].pr).toBeUndefined();
	});

	it("attaches both pr and agent when both correlate", () => {
		const snap: TeamGitHubSnapshot = {
			issues: [issue({ number: 51 })],
			prs: [pr({ number: 9, state: "open", headRefName: "issue-51-x" })],
		};
		const agents: AgentRef[] = [
			{ workspaceId: "ws1", name: "Ada", branch: "issue-51-x" },
		];
		const board = deriveWorkBoard(snap, agents);
		expect(board.doing[0].pr?.number).toBe(9);
		expect(board.doing[0].agent?.name).toBe("Ada");
	});

	it("uncorrelated open issues fall to todo", () => {
		const snap: TeamGitHubSnapshot = {
			issues: [issue({ number: 100 })],
			prs: [pr({ number: 9, state: "open", headRefName: "unrelated-branch" })],
		};
		const board = deriveWorkBoard(snap, []);
		expect(board.todo.map((i) => i.number)).toEqual([100]);
		expect(board.doing).toHaveLength(0);
	});

	it("sorts each column by updatedAt desc", () => {
		const snap: TeamGitHubSnapshot = {
			issues: [
				issue({
					number: 1,
					state: "closed",
					updatedAt: "2026-01-01T00:00:00Z",
				}),
				issue({
					number: 2,
					state: "closed",
					updatedAt: "2026-03-01T00:00:00Z",
				}),
				issue({
					number: 3,
					state: "closed",
					updatedAt: "2026-02-01T00:00:00Z",
				}),
			],
			prs: [],
		};
		const board = deriveWorkBoard(snap, []);
		expect(board.done.map((i) => i.number)).toEqual([2, 3, 1]);
	});
});

describe("deriveActivityFeed", () => {
	const snap: TeamGitHubSnapshot = {
		issues: [
			issue({ number: 10, state: "open", updatedAt: "2026-01-02T00:00:00Z" }),
			issue({
				number: 11,
				state: "closed",
				updatedAt: "2026-01-09T00:00:00Z",
				closedAt: "2026-01-05T00:00:00Z",
			}),
		],
		prs: [
			pr({ number: 20, state: "open", updatedAt: "2026-01-03T00:00:00Z" }),
			pr({
				number: 21,
				state: "merged",
				updatedAt: "2026-01-09T00:00:00Z",
				mergedAt: "2026-01-06T00:00:00Z",
			}),
			pr({ number: 22, state: "closed", updatedAt: "2026-01-04T00:00:00Z" }),
		],
	};

	it("maps kinds and timestamps correctly", () => {
		const feed = deriveActivityFeed(snap, [], 100);
		const byId = new Map(feed.map((e) => [e.id, e]));

		expect(byId.get("pr-opened-20")?.kind).toBe("pr-opened");
		expect(byId.get("pr-opened-20")?.at).toBe("2026-01-03T00:00:00Z");

		expect(byId.get("pr-merged-21")?.kind).toBe("pr-merged");
		expect(byId.get("pr-merged-21")?.at).toBe("2026-01-06T00:00:00Z");

		expect(byId.get("pr-closed-22")?.kind).toBe("pr-closed");
		expect(byId.get("pr-closed-22")?.at).toBe("2026-01-04T00:00:00Z");

		expect(byId.get("issue-opened-10")?.kind).toBe("issue-opened");
		expect(byId.get("issue-opened-10")?.at).toBe("2026-01-02T00:00:00Z");

		// closed issue uses closedAt, not updatedAt
		expect(byId.get("issue-closed-11")?.kind).toBe("issue-closed");
		expect(byId.get("issue-closed-11")?.at).toBe("2026-01-05T00:00:00Z");
	});

	it("falls back to updatedAt when a closed issue has no closedAt", () => {
		const s: TeamGitHubSnapshot = {
			issues: [
				issue({
					number: 30,
					state: "closed",
					updatedAt: "2026-01-08T00:00:00Z",
					closedAt: null,
				}),
			],
			prs: [],
		};
		const feed = deriveActivityFeed(s, [], 10);
		expect(feed[0].at).toBe("2026-01-08T00:00:00Z");
	});

	it("interleaves mail and sorts everything by `at` desc", () => {
		const mail: MailEvent[] = [
			{
				id: "mail-1",
				thread: "t1",
				from: "ada",
				to: "bob",
				status: "sent",
				at: "2026-01-07T00:00:00Z",
				subjectLine: "Need a hand",
			},
		];
		const feed = deriveActivityFeed(snap, mail, 100);

		// Descending by `at`.
		const times = feed.map((e) => Date.parse(e.at));
		for (let i = 1; i < times.length; i++) {
			expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
		}

		const mailEvent = feed.find((e) => e.id === "mail-1");
		expect(mailEvent?.kind).toBe("mail");
		expect(mailEvent?.title).toBe("Need a hand");
		expect(mailEvent?.actor).toBe("ada");
		expect(mailEvent?.url).toBeNull();
		expect(mailEvent?.number).toBeNull();

		// Mail @01-07 sits between issue-closed-11 @01-05 and the 01-09-ish tail.
		const ids = feed.map((e) => e.id);
		expect(ids.indexOf("mail-1")).toBeLessThan(ids.indexOf("issue-closed-11"));
	});

	it("honors the limit", () => {
		const feed = deriveActivityFeed(snap, [], 2);
		expect(feed).toHaveLength(2);
		// The two most recent events (both @01-06 merged, and next).
		expect(feed[0].id).toBe("pr-merged-21");
	});
});

describe("fetchTeamGitHubSnapshot", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "github-team-test-"));
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns empty arrays when pointed at a non-repo dir", async () => {
		const snap = await fetchTeamGitHubSnapshot(dir);
		expect(snap).toEqual({ issues: [], prs: [] });
	});
});

describe("fetchTeamGitHubSnapshot cache (issue #66)", () => {
	afterEach(() => {
		clearTeamGitHubSnapshotCache();
	});

	function snapshot(n: number): TeamGitHubSnapshot {
		return { issues: [issue({ number: n })], prs: [] };
	}

	it("fresh miss awaits the live fetch", async () => {
		let calls = 0;
		const fetcher = async () => {
			calls++;
			return snapshot(1);
		};
		const result = await refreshTeamGitHubSnapshotCache("repo-a", fetcher);
		expect(result).toEqual(snapshot(1));
		expect(calls).toBe(1);
	});

	it("hit within TTL returns cached without spawning", async () => {
		seedTeamGitHubSnapshotCacheForTest("repo-b", snapshot(1), 0);

		// A fresh-TTL entry means fetchTeamGitHubSnapshot must return straight
		// from the cache without ever touching the (real, `gh`-backed) fetcher —
		// there is no injectable-fetcher seam on this path to spy on, so the
		// absence of a spawn is exactly what "resolves without needing gh" means
		// here: the call resolves immediately with the seeded data.
		const result = await fetchTeamGitHubSnapshot("repo-b");
		expect(result).toEqual(snapshot(1));
	});

	it("stale hit returns stale immediately and triggers exactly one refresh under concurrent calls", async () => {
		let calls = 0;
		let resolveRefresh: (() => void) | undefined;
		const fetcher = async () => {
			calls++;
			await new Promise<void>((resolve) => {
				resolveRefresh = resolve;
			});
			return snapshot(2);
		};

		// Three concurrent low-level refresh calls for the same key must share
		// a single in-flight fetch (this is the exact primitive a stale hit in
		// fetchTeamGitHubSnapshot delegates to).
		const first = refreshTeamGitHubSnapshotCache("repo-c", fetcher);
		const second = refreshTeamGitHubSnapshotCache("repo-c", fetcher);
		const third = refreshTeamGitHubSnapshotCache("repo-c", fetcher);
		expect(calls).toBe(1);

		resolveRefresh?.();
		const [r1, r2, r3] = await Promise.all([first, second, third]);
		expect(r1).toEqual(snapshot(2));
		expect(r2).toEqual(snapshot(2));
		expect(r3).toEqual(snapshot(2));
		expect(calls).toBe(1);
	});

	it("stale read through the public API returns stale data without waiting on the refresh", async () => {
		let resolveSlow: ((value: TeamGitHubSnapshot) => void) | undefined;
		seedTeamGitHubSnapshotCacheForTest(
			"repo-d",
			snapshot(1),
			SNAPSHOT_CACHE_TTL_MS + 1,
		);

		// Kick a slow low-level refresh under the same key first, so the public
		// call below observes it already in flight (it would otherwise start
		// its own refresh against the real `gh`-backed fetcher).
		const refreshPromise = refreshTeamGitHubSnapshotCache("repo-d", () => {
			return new Promise<TeamGitHubSnapshot>((resolve) => {
				resolveSlow = resolve;
			});
		});

		const result = await fetchTeamGitHubSnapshot("repo-d");
		expect(result).toEqual(snapshot(1));

		resolveSlow?.(snapshot(2));
		await refreshPromise;
	});

	it("refresh failure keeps serving stale (cache untouched, no throw to the caller)", async () => {
		const seeded = await refreshTeamGitHubSnapshotCache(
			"repo-e",
			async () => snapshot(1),
		);
		expect(seeded).toEqual(snapshot(1));

		// A failing refresh rejects its own promise (a caller who explicitly
		// awaits a refresh can observe the failure)...
		const failing = refreshTeamGitHubSnapshotCache("repo-e", async () => {
			throw new Error("gh exploded");
		});
		await expect(failing).rejects.toThrow("gh exploded");

		// ...but must not clobber the cached entry: the failed refresh's `.then`
		// (where snapshotCache.set happens) never ran, so the still-fresh entry
		// from the successful seed above is untouched. Reading through the
		// public API confirms it — a fresh-TTL hit, no fetcher involved at all,
		// still returns the last good snapshot rather than throwing or going
		// empty.
		const stillCached = await fetchTeamGitHubSnapshot("repo-e");
		expect(stillCached).toEqual(seeded);
	});
});

// ---------------------------------------------------------------------------
// REST -> shape mapping (issue #67)
// ---------------------------------------------------------------------------

describe("parseRepoRef", () => {
	it("parses https remotes", () => {
		expect(
			parseRepoRef("https://github.com/CameronCrow/ade-windows-port.git"),
		).toEqual({
			owner: "CameronCrow",
			repo: "ade-windows-port",
			apiBase: "https://api.github.com",
			htmlUrl: "https://github.com/CameronCrow/ade-windows-port",
		});
	});

	it("parses scp-style ssh remotes", () => {
		expect(parseRepoRef("git@github.com:CameronCrow/ade-windows-port.git")).toEqual({
			owner: "CameronCrow",
			repo: "ade-windows-port",
			apiBase: "https://api.github.com",
			htmlUrl: "https://github.com/CameronCrow/ade-windows-port",
		});
	});

	it("parses ssh:// remotes without a .git suffix", () => {
		expect(parseRepoRef("ssh://git@github.com/acme/widgets")).toEqual({
			owner: "acme",
			repo: "widgets",
			apiBase: "https://api.github.com",
			htmlUrl: "https://github.com/acme/widgets",
		});
	});

	it("maps a GitHub Enterprise host to /api/v3", () => {
		const ref = parseRepoRef("https://ghe.corp.example/acme/widgets.git");
		expect(ref?.apiBase).toBe("https://ghe.corp.example/api/v3");
		expect(ref?.htmlUrl).toBe("https://ghe.corp.example/acme/widgets");
	});

	it("returns null for garbage", () => {
		expect(parseRepoRef("")).toBeNull();
		expect(parseRepoRef("not-a-url")).toBeNull();
	});
});

describe("restChecksToCheckItems + checksStatusFromItems", () => {
	it("maps a passing check-run to success", () => {
		const items = restChecksToCheckItems(
			{
				check_runs: [
					{
						name: "build",
						status: "completed",
						conclusion: "success",
						details_url: "https://ci/build",
					},
				],
			},
			null,
		);
		expect(items).toEqual([
			{ name: "build", status: "success", url: "https://ci/build" },
		]);
		expect(checksStatusFromItems(items)).toBe("success");
	});

	it("maps a failing check-run to failure and rolls up to failure", () => {
		const items = restChecksToCheckItems(
			{
				check_runs: [
					{ name: "build", status: "completed", conclusion: "success" },
					{ name: "test", status: "completed", conclusion: "failure" },
				],
			},
			null,
		);
		expect(items.map((i) => i.status)).toEqual(["success", "failure"]);
		expect(checksStatusFromItems(items)).toBe("failure");
	});

	it("maps an in-progress check-run to pending and rolls up to pending", () => {
		const items = restChecksToCheckItems(
			{
				check_runs: [
					{ name: "build", status: "completed", conclusion: "success" },
					{ name: "deploy", status: "in_progress", conclusion: null },
				],
			},
			null,
		);
		expect(items.map((i) => i.status)).toEqual(["success", "pending"]);
		expect(checksStatusFromItems(items)).toBe("pending");
	});

	it("failure outranks pending in the rollup", () => {
		const items = restChecksToCheckItems(
			{
				check_runs: [
					{ name: "a", status: "in_progress" },
					{ name: "b", status: "completed", conclusion: "failure" },
				],
			},
			null,
		);
		expect(checksStatusFromItems(items)).toBe("failure");
	});

	it("skipped/cancelled do not count as failure or pending", () => {
		const items = restChecksToCheckItems(
			{
				check_runs: [
					{ name: "a", status: "completed", conclusion: "skipped" },
					{ name: "b", status: "completed", conclusion: "cancelled" },
					{ name: "c", status: "completed", conclusion: "success" },
				],
			},
			null,
		);
		expect(checksStatusFromItems(items)).toBe("success");
	});

	it("merges legacy commit statuses alongside check-runs", () => {
		const items = restChecksToCheckItems(
			{
				check_runs: [
					{ name: "build", status: "completed", conclusion: "success" },
				],
			},
			{
				statuses: [
					{
						context: "ci/legacy",
						state: "pending",
						target_url: "https://ci/legacy",
					},
				],
			},
		);
		expect(items).toContainEqual({
			name: "ci/legacy",
			status: "pending",
			url: "https://ci/legacy",
		});
		expect(checksStatusFromItems(items)).toBe("pending");
	});

	it("returns none for no checks and tolerates garbage input", () => {
		expect(checksStatusFromItems(restChecksToCheckItems(null, null))).toBe(
			"none",
		);
		expect(checksStatusFromItems(restChecksToCheckItems({}, {}))).toBe("none");
	});
});

describe("computeReviewDecision", () => {
	it("changes_requested wins over an earlier approval by the same user", () => {
		expect(
			computeReviewDecision([
				{ user: { login: "ada" }, state: "APPROVED" },
				{ user: { login: "ada" }, state: "CHANGES_REQUESTED" },
			]),
		).toBe("changes_requested");
	});

	it("a superseding approval clears an earlier change request", () => {
		expect(
			computeReviewDecision([
				{ user: { login: "ada" }, state: "CHANGES_REQUESTED" },
				{ user: { login: "ada" }, state: "APPROVED" },
			]),
		).toBe("approved");
	});

	it("ignores COMMENTED reviews and defaults to pending", () => {
		expect(
			computeReviewDecision([{ user: { login: "ada" }, state: "COMMENTED" }]),
		).toBe("pending");
		expect(computeReviewDecision([])).toBe("pending");
		expect(computeReviewDecision(null)).toBe("pending");
	});
});

describe("mapRestIssueToTeam", () => {
	it("maps a REST issue to the snapshot shape", () => {
		expect(
			mapRestIssueToTeam({
				number: 42,
				title: "Do the thing",
				html_url: "https://github.com/o/r/issues/42",
				state: "open",
				labels: [{ name: "bug" }, "urgent"],
				assignees: [{ login: "ada" }],
				body: "details",
				updated_at: "2026-01-02T00:00:00Z",
				closed_at: null,
			}),
		).toEqual({
			number: 42,
			title: "Do the thing",
			url: "https://github.com/o/r/issues/42",
			state: "open",
			labels: ["bug", "urgent"],
			assignees: ["ada"],
			body: "details",
			updatedAt: "2026-01-02T00:00:00Z",
			closedAt: null,
		});
	});

	it("skips PRs that the /issues endpoint mixes in", () => {
		expect(
			mapRestIssueToTeam({
				number: 9,
				title: "a pr",
				html_url: "https://github.com/o/r/pull/9",
				state: "open",
				updated_at: "2026-01-02T00:00:00Z",
				pull_request: { url: "https://api/pulls/9" },
			}),
		).toBeNull();
	});

	it("defaults null body and missing labels/assignees", () => {
		const mapped = mapRestIssueToTeam({
			number: 5,
			title: "bare",
			html_url: "u",
			state: "closed",
			body: null,
			updated_at: "2026-01-02T00:00:00Z",
			closed_at: "2026-01-03T00:00:00Z",
		});
		expect(mapped).toMatchObject({
			state: "closed",
			labels: [],
			assignees: [],
			body: "",
			closedAt: "2026-01-03T00:00:00Z",
		});
	});
});

describe("mapRestPRToTeam", () => {
	it("maps an open REST PR with its resolved checks status", () => {
		expect(
			mapRestPRToTeam(
				{
					number: 12,
					title: "Add feature",
					html_url: "https://github.com/o/r/pull/12",
					state: "open",
					draft: false,
					merged_at: null,
					body: "Closes #42",
					updated_at: "2026-01-04T00:00:00Z",
					head: { ref: "feat/thing", sha: "abc123" },
				},
				"pending",
			),
		).toEqual({
			number: 12,
			title: "Add feature",
			url: "https://github.com/o/r/pull/12",
			state: "open",
			headRefName: "feat/thing",
			body: "Closes #42",
			checksStatus: "pending",
			updatedAt: "2026-01-04T00:00:00Z",
			mergedAt: null,
		});
	});

	it("normalizes closed+merged_at to merged", () => {
		const mapped = mapRestPRToTeam(
			{
				number: 13,
				title: "Merged one",
				html_url: "u",
				state: "closed",
				merged_at: "2026-01-06T00:00:00Z",
				updated_at: "2026-01-06T00:00:00Z",
				head: { ref: "b", sha: "s" },
			},
			"none",
		);
		expect(mapped?.state).toBe("merged");
		expect(mapped?.mergedAt).toBe("2026-01-06T00:00:00Z");
	});

	it("maps closed-unmerged to closed", () => {
		const mapped = mapRestPRToTeam(
			{
				number: 14,
				title: "Closed one",
				html_url: "u",
				state: "closed",
				merged_at: null,
				updated_at: "2026-01-06T00:00:00Z",
				head: { ref: "b", sha: "s" },
			},
			"none",
		);
		expect(mapped?.state).toBe("closed");
	});
});

describe("formatWorktreePR", () => {
	const basePull = {
		number: 7,
		title: "WIP",
		html_url: "https://github.com/o/r/pull/7",
		state: "open",
		draft: false,
		merged_at: null,
		body: "",
		updated_at: "2026-01-04T00:00:00Z",
		head: { ref: "feat/x", sha: "deadbeef" },
	};

	it("builds the worktree PR shape from REST pieces", () => {
		const pr = formatWorktreePR(basePull, 10, 3, "approved", [
			{ name: "build", status: "success" },
		]);
		expect(pr).toEqual({
			number: 7,
			title: "WIP",
			url: "https://github.com/o/r/pull/7",
			state: "open",
			mergedAt: undefined,
			additions: 10,
			deletions: 3,
			reviewDecision: "approved",
			checksStatus: "success",
			checks: [{ name: "build", status: "success" }],
		});
	});

	it("maps draft PRs to state draft", () => {
		const pr = formatWorktreePR(
			{ ...basePull, draft: true },
			0,
			0,
			"pending",
			[],
		);
		expect(pr.state).toBe("draft");
		expect(pr.checksStatus).toBe("none");
	});

	it("maps merged PRs to state merged with a numeric mergedAt", () => {
		const pr = formatWorktreePR(
			{ ...basePull, state: "closed", merged_at: "2026-01-06T00:00:00Z" },
			0,
			0,
			"approved",
			[],
		);
		expect(pr.state).toBe("merged");
		expect(pr.mergedAt).toBe(Date.parse("2026-01-06T00:00:00Z"));
	});
});
