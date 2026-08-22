/**
 * The double-replay guard's edges (B1).
 *
 * `restore.test.ts` covers the three ordinary answers. What is here is the
 * inputs the guard actually receives at runtime and the property it has to
 * hold across them: a persisted id that is present but empty, a store that a
 * remount left partly populated, and the invariant that "already has entries"
 * ALWAYS wins — because a wrong `true` replays a whole conversation into a
 * transcript that already holds it, and neither the reducer nor the protocol
 * can tell the copies apart afterwards.
 */

import { describe, expect, it } from "bun:test";
import { restoreNotice, shouldResumeSession } from "./restore";

describe("shouldResumeSession — persisted id edges", () => {
	it("refuses an empty-string id", () => {
		// `AcpPaneState.acpSessionId` is written by the pane on every session
		// start; an empty string is what a session that failed its handshake
		// leaves behind, and `session/load ""` is not a restore.
		expect(
			shouldResumeSession({ storedSessionId: "", transcriptEntryCount: 0 }),
		).toBe(false);
	});

	it("refuses a whitespace-only id, if one is ever persisted", () => {
		// Documents the CURRENT answer rather than asserting a wish: the guard
		// tests truthiness, so " " resumes. Recorded here so a future trim is a
		// deliberate change with a failing test, not a silent one.
		expect(
			shouldResumeSession({ storedSessionId: " ", transcriptEntryCount: 0 }),
		).toBe(true);
	});
});

describe("shouldResumeSession — the guard never loses to the id", () => {
	it("blocks at ONE entry, not just at many", () => {
		// The boundary. A guard written as `count < 2` (or against a "has real
		// content" heuristic) would let a single divider or a single restored
		// notice through and replay the whole conversation under it.
		expect(
			shouldResumeSession({
				storedSessionId: "sess-1",
				transcriptEntryCount: 1,
			}),
		).toBe(false);
	});

	it("blocks for every populated count", () => {
		for (const count of [1, 2, 7, 500]) {
			expect(
				shouldResumeSession({
					storedSessionId: "sess-1",
					transcriptEntryCount: count,
				}),
			).toBe(false);
		}
	});

	it("PROVES THE GUARD IS THE THING SAYING NO: the same id at zero resumes", () => {
		expect(
			shouldResumeSession({
				storedSessionId: "sess-1",
				transcriptEntryCount: 0,
			}),
		).toBe(true);
	});

	it("stays false without an id no matter how empty the store is", () => {
		expect(
			shouldResumeSession({
				storedSessionId: undefined,
				transcriptEntryCount: 0,
			}),
		).toBe(false);
	});
});

describe("restoreNotice", () => {
	it("says nothing on a replay THIS mount never requested (A10)", () => {
		// Not the unreachable case it looks like. `ensureSession` short-circuits
		// a live pane to its session info, and `restored` there is a
		// SESSION-lifetime value — it keeps reading "replayed" for every later
		// remount of a session that was restored once. Reporting it as a
		// this-mount fact re-raises the strip on every mosaic split, forever,
		// announcing a restore that did not happen on this mount.
		expect(
			restoreNotice({ requestedSessionId: null, restored: "replayed" }),
		).toBe(null);

		// PROVES THE NOTICE STILL WORKS: the mount that actually asked for the
		// restore still gets told. A fix that silenced both would have deleted
		// the feature instead of scoping it.
		expect(
			restoreNotice({ requestedSessionId: "sess-1", restored: "replayed" }),
		).toBe("Restored previous session.");
	});

	it("distinguishes the two `fresh` cases by what was ASKED for", () => {
		// Same `restored` value, opposite messages. This is the honesty rule the
		// design names: a pane that quietly started an empty conversation looks
		// exactly like a successful restore unless the failure is said out loud.
		expect(
			restoreNotice({ requestedSessionId: "sess-1", restored: "fresh" }),
		).toBe("Previous session could not be restored — new session started.");
		expect(restoreNotice({ requestedSessionId: null, restored: "fresh" })).toBe(
			null,
		);
	});
});
