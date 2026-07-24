import { describe, expect, test } from "bun:test";
import { parseUsageWindow } from "./provider-usage";

describe("parseUsageWindow", () => {
	test("parses a well-formed window", () => {
		expect(
			parseUsageWindow({ utilization: 42, resets_at: "2026-07-16T20:00:00Z" }),
		).toEqual({ utilization: 42, resetsAt: "2026-07-16T20:00:00Z" });
	});

	test("tolerates a missing resets_at", () => {
		expect(parseUsageWindow({ utilization: 0 })).toEqual({
			utilization: 0,
			resetsAt: null,
		});
	});

	test("rejects malformed values", () => {
		expect(parseUsageWindow(null)).toBeNull();
		expect(parseUsageWindow(undefined)).toBeNull();
		expect(parseUsageWindow("42%")).toBeNull();
		expect(parseUsageWindow({ utilization: "42" })).toBeNull();
	});
});
