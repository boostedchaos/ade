/**
 * Smoke coverage for the restore guard (B1). An independent author follows.
 */

import { describe, expect, it } from "bun:test";
import { restoreNotice, shouldResumeSession } from "./restore";

describe("shouldResumeSession", () => {
	it("resumes a stored id into an empty transcript", () => {
		expect(
			shouldResumeSession({
				storedSessionId: "sess-1",
				transcriptEntryCount: 0,
			}),
		).toBe(true);
	});

	it("does NOT resume when the transcript is already populated", () => {
		// The double-replay guard: a mosaic remount runs the mount effect again
		// against a store that survived it.
		expect(
			shouldResumeSession({
				storedSessionId: "sess-1",
				transcriptEntryCount: 3,
			}),
		).toBe(false);
	});

	it("does not resume without a stored id", () => {
		expect(
			shouldResumeSession({
				storedSessionId: undefined,
				transcriptEntryCount: 0,
			}),
		).toBe(false);
	});
});

describe("restoreNotice", () => {
	it("says so on a replay", () => {
		expect(
			restoreNotice({ requestedSessionId: "sess-1", restored: "replayed" }),
		).toBe("Restored previous session.");
	});

	it("says the restore FAILED when a stored id came back fresh", () => {
		expect(
			restoreNotice({ requestedSessionId: "sess-1", restored: "fresh" }),
		).toBe("Previous session could not be restored — new session started.");
	});

	it("says nothing for an ordinary first start", () => {
		expect(restoreNotice({ requestedSessionId: null, restored: "fresh" })).toBe(
			null,
		);
	});
});
