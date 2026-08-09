import { describe, expect, it } from "bun:test";
import {
	dockBadgeText,
	isUnread,
	panesWithUnreadAttention,
	unreadAttentionByPane,
	unreadCount,
} from "./selectors";
import type { NotificationRecord } from "./store";

function record(over: Partial<NotificationRecord> = {}): NotificationRecord {
	return {
		id: "n1",
		kind: "attention",
		title: "needs input",
		body: "",
		paneId: "pane-1",
		workspaceId: "ws-1",
		createdAt: 1_000,
		readAt: null,
		...over,
	};
}

describe("unreadCount", () => {
	it("counts both kinds", () => {
		expect(
			unreadCount([
				record(),
				record({ id: "n2", kind: "custom" }),
				record({ id: "n3", readAt: 5 }),
			]),
		).toBe(2);
	});

	it("treats readAt: 0 as read, not as falsy-unread", () => {
		// A row marked read at epoch 0 is pathological but the check must be
		// `=== null`, not truthiness, or the badge would never clear for it.
		expect(isUnread(record({ readAt: 0 }))).toBe(false);
	});
});

describe("unreadAttentionByPane", () => {
	it("counts unread attention rows per pane", () => {
		const counts = unreadAttentionByPane([
			record({ id: "a", paneId: "p1" }),
			record({ id: "b", paneId: "p1" }),
			record({ id: "c", paneId: "p2" }),
		]);
		expect(counts).toEqual({ p1: 2, p2: 1 });
	});

	it("excludes custom notifications — a build-finished note is not a block", () => {
		expect(
			unreadAttentionByPane([record({ kind: "custom", paneId: "p1" })]),
		).toEqual({});
	});

	it("excludes read rows and rows with no pane", () => {
		expect(
			unreadAttentionByPane([
				record({ id: "a", paneId: "p1", readAt: 9 }),
				record({ id: "b", paneId: null }),
			]),
		).toEqual({});
	});
});

describe("panesWithUnreadAttention", () => {
	it("orders newest ask first regardless of input order", () => {
		expect(
			panesWithUnreadAttention([
				record({ id: "old", paneId: "p1", createdAt: 100 }),
				record({ id: "new", paneId: "p2", createdAt: 900 }),
				record({ id: "mid", paneId: "p3", createdAt: 500 }),
			]),
		).toEqual(["p2", "p3", "p1"]);
	});

	it("lists a pane once even with several unread asks", () => {
		expect(
			panesWithUnreadAttention([
				record({ id: "a", paneId: "p1", createdAt: 100 }),
				record({ id: "b", paneId: "p1", createdAt: 200 }),
			]),
		).toEqual(["p1"]);
	});

	it("ignores custom, read, and pane-less rows", () => {
		expect(
			panesWithUnreadAttention([
				record({ id: "a", kind: "custom", paneId: "p1" }),
				record({ id: "b", paneId: "p2", readAt: 1 }),
				record({ id: "c", paneId: null }),
			]),
		).toEqual([]);
	});
});

describe("dockBadgeText", () => {
	it("is empty for zero — setBadge('0') would paint a literal zero", () => {
		expect(dockBadgeText(0)).toBe("");
		expect(dockBadgeText(-1)).toBe("");
	});

	it("prints the count, capped at 99+", () => {
		expect(dockBadgeText(1)).toBe("1");
		expect(dockBadgeText(99)).toBe("99");
		expect(dockBadgeText(100)).toBe("99+");
	});
});
