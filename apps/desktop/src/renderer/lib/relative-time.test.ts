import { describe, expect, it } from "bun:test";
import { relativeTime } from "./relative-time";

/**
 * `now` is injected rather than read from the clock so these assert the
 * FUNCTION, not the moment the suite happened to run. A test that calls
 * Date.now() inside the assertion passes or fails on timing.
 */
describe("relativeTime", () => {
	const NOW = 1_700_000_000_000;

	it("says 'just now' under a minute", () => {
		expect(relativeTime(NOW - 1_000, NOW)).toBe("just now");
		expect(relativeTime(NOW - 59_000, NOW)).toBe("just now");
	});

	it("counts minutes, then hours, then days", () => {
		expect(relativeTime(NOW - 4 * 60_000, NOW)).toBe("4m ago");
		expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
		expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe("2d ago");
	});

	it("never renders a negative age from a clock skew", () => {
		// A timestamp from the future (main and renderer disagreeing by a few
		// ms is normal) must not produce "-1m ago" in the blocked strip.
		expect(relativeTime(NOW + 60_000, NOW)).toBe("just now");
	});
});
