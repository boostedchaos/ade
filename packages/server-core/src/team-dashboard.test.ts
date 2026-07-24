import { afterEach, describe, expect, it } from "bun:test";
import {
	applyRosterOverlay,
	deriveRosterStatus,
	type RosterEntry,
	type RosterPROverlay,
	rosterGitHubDelayMs,
} from "./team-dashboard";

/**
 * team-dashboard unit tests. The pure status-precedence seam (deriveRosterStatus)
 * plus the issue #65 first-paint split: the roster is built from local data only,
 * and the GitHub PR half arrives separately as an overlay that's merged in via the
 * pure `applyRosterOverlay`. buildRoster/buildRosterGitHub themselves reach out to
 * the filesystem and `gh`, which isn't worth mocking here.
 */
describe("deriveRosterStatus", () => {
	it("blocks when PR checks are failing, regardless of activity", () => {
		for (const activity of ["working", "waiting", "idle", "unknown"] as const) {
			expect(deriveRosterStatus(activity, "failure")).toBe("blocked");
		}
	});

	it("passes through the session activity when checks are not failing", () => {
		expect(deriveRosterStatus("working", "success")).toBe("working");
		expect(deriveRosterStatus("waiting", "pending")).toBe("waiting");
		expect(deriveRosterStatus("idle", "none")).toBe("idle");
		expect(deriveRosterStatus("working", null)).toBe("working");
		expect(deriveRosterStatus("unknown", null)).toBe("unknown");
	});
});

// A local-only roster entry as buildRoster now produces it (issue #65): status
// from activity alone, PR column not yet populated.
function localEntry(overrides: Partial<RosterEntry> = {}): RosterEntry {
	return {
		workspaceId: "ws1",
		name: "Agent One",
		iconUrl: null,
		branch: "feat/x",
		status: "working",
		session: { model: "claude-opus-4-8", contextTokens: 1234 },
		pr: null,
		lastActivityAt: 1000,
		...overrides,
	};
}

describe("applyRosterOverlay (issue #65 first-paint split)", () => {
	it("leaves an entry untouched when the overlay has no row for it", () => {
		const roster = [localEntry()];
		const merged = applyRosterOverlay(roster, []);
		expect(merged[0]).toEqual(roster[0]);
		// A missing overlay must never fabricate "blocked" — status from activity.
		expect(merged[0].status).toBe("working");
		expect(merged[0].pr).toBeNull();
	});

	it("hydrates the PR column without changing status when checks pass", () => {
		const overlay: RosterPROverlay[] = [
			{
				workspaceId: "ws1",
				pr: { number: 42, title: "T", url: "u", checksStatus: "success" },
			},
		];
		const merged = applyRosterOverlay([localEntry({ status: "waiting" })], overlay);
		expect(merged[0].pr).toEqual(overlay[0].pr);
		expect(merged[0].status).toBe("waiting");
	});

	it("promotes to blocked only once a failing overlay is present", () => {
		const entry = localEntry({ status: "working" });
		// Before the overlay: not blocked.
		expect(applyRosterOverlay([entry], [])[0].status).toBe("working");
		// After a failing overlay: blocked.
		const overlay: RosterPROverlay[] = [
			{
				workspaceId: "ws1",
				pr: { number: 7, title: "T", url: "u", checksStatus: "failure" },
			},
		];
		expect(applyRosterOverlay([entry], overlay)[0].status).toBe("blocked");
	});

	it("applies a null-PR overlay row (agent has no PR) without blocking", () => {
		const overlay: RosterPROverlay[] = [{ workspaceId: "ws1", pr: null }];
		const merged = applyRosterOverlay([localEntry({ status: "idle" })], overlay);
		expect(merged[0].pr).toBeNull();
		expect(merged[0].status).toBe("idle");
	});

	it("matches overlay rows to entries by workspaceId", () => {
		const a = localEntry({ workspaceId: "a", status: "working" });
		const b = localEntry({ workspaceId: "b", status: "idle" });
		const overlay: RosterPROverlay[] = [
			{
				workspaceId: "b",
				pr: { number: 9, title: "T", url: "u", checksStatus: "failure" },
			},
		];
		const merged = applyRosterOverlay([a, b], overlay);
		expect(merged[0].status).toBe("working"); // a: no overlay row
		expect(merged[1].status).toBe("blocked"); // b: failing overlay
	});
});

describe("rosterGitHubDelayMs (issue #65 acceptance hook)", () => {
	const original = process.env.ADE_DASHBOARD_GH_DELAY_MS;
	afterEach(() => {
		if (original === undefined) delete process.env.ADE_DASHBOARD_GH_DELAY_MS;
		else process.env.ADE_DASHBOARD_GH_DELAY_MS = original;
	});

	it("is 0 when the env var is unset", () => {
		delete process.env.ADE_DASHBOARD_GH_DELAY_MS;
		expect(rosterGitHubDelayMs()).toBe(0);
	});

	it("parses a positive integer delay", () => {
		process.env.ADE_DASHBOARD_GH_DELAY_MS = "30000";
		expect(rosterGitHubDelayMs()).toBe(30000);
	});

	it("ignores non-positive or non-numeric values", () => {
		for (const bad of ["0", "-5", "abc", ""]) {
			process.env.ADE_DASHBOARD_GH_DELAY_MS = bad;
			expect(rosterGitHubDelayMs()).toBe(0);
		}
	});
});
