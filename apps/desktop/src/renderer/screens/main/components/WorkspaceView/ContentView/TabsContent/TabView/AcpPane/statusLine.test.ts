import { describe, expect, it } from "bun:test";
import type { AcpPaneLifecycle } from "./AcpStatusLine";
import {
	NEW_SESSION_CONFIRM_LABEL,
	NEW_SESSION_LABEL,
	newSessionLabel,
	restartNeedsConfirm,
} from "./statusLine";

const LIVE: AcpPaneLifecycle[] = ["idle", "starting", "ready", "streaming"];

describe("restartNeedsConfirm", () => {
	it("never confirms a dead session — restarting one is the recovery path", () => {
		expect(
			restartNeedsConfirm({ lifecycle: "dead", transcriptEntryCount: 12 }),
		).toBe(false);
	});

	it("confirms on every live lifecycle when the transcript holds something", () => {
		for (const lifecycle of LIVE) {
			expect(restartNeedsConfirm({ lifecycle, transcriptEntryCount: 1 })).toBe(
				true,
			);
		}
	});

	it("does NOT confirm a live session with an empty transcript", () => {
		// A confirm nobody needs is a confirm that gets dismissed unread, which
		// is how the guard stops guarding the one case that matters.
		for (const lifecycle of LIVE) {
			expect(restartNeedsConfirm({ lifecycle, transcriptEntryCount: 0 })).toBe(
				false,
			);
		}
	});

	it("keys on the transcript, not the lifecycle — a mid-stream turn is still protected", () => {
		expect(
			restartNeedsConfirm({ lifecycle: "streaming", transcriptEntryCount: 3 }),
		).toBe(true);
	});
});

describe("newSessionLabel", () => {
	it("reads as a question only once armed", () => {
		expect(newSessionLabel(false)).toBe(NEW_SESSION_LABEL);
		expect(newSessionLabel(true)).toBe(NEW_SESSION_CONFIRM_LABEL);
	});

	it("the two labels differ, so an armed button is visibly not the idle one", () => {
		expect(NEW_SESSION_LABEL).not.toBe(NEW_SESSION_CONFIRM_LABEL);
	});
});
