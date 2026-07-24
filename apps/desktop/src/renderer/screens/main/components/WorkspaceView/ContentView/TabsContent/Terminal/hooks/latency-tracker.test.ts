import { afterEach, describe, expect, it } from "bun:test";
import {
	getLatencySnapshot,
	isLatencyIdle,
	markLatencyInput,
	recordLatencyPing,
	refreshLatencySnapshot,
	resetLatencyForTests,
	setLatencyNowForTests,
	subscribeLatency,
	takeLatencyPending,
} from "./latency-tracker";

const PANE = "test-pane";

/** Manual clock: tests advance time explicitly, no real sleeps. */
function useClock(start = 1000) {
	let t = start;
	setLatencyNowForTests(() => t);
	return {
		advance(ms: number) {
			t += ms;
		},
	};
}

/** Stamp a keystroke, advance the clock, resolve on the next chunk. */
function sample(clock: { advance: (ms: number) => void }, echoMs: number) {
	markLatencyInput(PANE, "a");
	clock.advance(echoMs);
	const resolve = takeLatencyPending(PANE);
	expect(resolve).not.toBeNull();
	resolve?.();
}

afterEach(() => {
	resetLatencyForTests(PANE);
	setLatencyNowForTests();
});

describe("latency-tracker", () => {
	it("resolves a stamped keystroke into an echo sample", () => {
		const clock = useClock();
		sample(clock, 12);
		expect(getLatencySnapshot(PANE)).toEqual({ echoMs: 12, source: "echo" });
	});

	it("has no reading before any samples", () => {
		useClock();
		expect(getLatencySnapshot(PANE)).toEqual({ echoMs: null, source: null });
		expect(takeLatencyPending(PANE)).toBeNull();
	});

	it("ignores paste-sized writes", () => {
		useClock();
		markLatencyInput(PANE, "pasted text longer than a keystroke");
		expect(takeLatencyPending(PANE)).toBeNull();
	});

	it("ignores empty writes", () => {
		useClock();
		markLatencyInput(PANE, "");
		expect(takeLatencyPending(PANE)).toBeNull();
	});

	it("accepts escape-sequence-sized keystrokes (arrow keys)", () => {
		const clock = useClock();
		markLatencyInput(PANE, "\x1b[A");
		clock.advance(8);
		const resolve = takeLatencyPending(PANE);
		expect(resolve).not.toBeNull();
		resolve?.();
		expect(getLatencySnapshot(PANE).echoMs).toBe(8);
	});

	it("is single-in-flight: a second keystroke does not restart the pending stamp", () => {
		const clock = useClock();
		markLatencyInput(PANE, "a");
		clock.advance(10);
		markLatencyInput(PANE, "b"); // ignored — first stamp wins
		clock.advance(10);
		takeLatencyPending(PANE)?.();
		// Measured from the FIRST keystroke: 20ms, not 10ms.
		expect(getLatencySnapshot(PANE).echoMs).toBe(20);
	});

	it("computes the median over the window (odd and even counts)", () => {
		const clock = useClock();
		sample(clock, 10);
		sample(clock, 30);
		expect(getLatencySnapshot(PANE).echoMs).toBe(20); // even: (10+30)/2
		sample(clock, 50);
		expect(getLatencySnapshot(PANE).echoMs).toBe(30); // odd: middle
	});

	it("caps the rolling window at 20 samples", () => {
		const clock = useClock();
		for (let i = 0; i < 20; i++) sample(clock, 100);
		expect(getLatencySnapshot(PANE).echoMs).toBe(100);
		// 20 fast samples push every 100ms sample out of the window.
		for (let i = 0; i < 20; i++) sample(clock, 4);
		expect(getLatencySnapshot(PANE).echoMs).toBe(4);
	});

	it("discards a stale pending stamp instead of pairing it with late output", () => {
		const clock = useClock();
		markLatencyInput(PANE, "a");
		clock.advance(5000); // no echo for 5s — not this keystroke's echo
		expect(takeLatencyPending(PANE)).toBeNull();
		expect(getLatencySnapshot(PANE).echoMs).toBeNull();
	});

	it("lets a new keystroke replace a stale pending stamp", () => {
		const clock = useClock();
		markLatencyInput(PANE, "a");
		clock.advance(5000);
		markLatencyInput(PANE, "b"); // stale stamp replaced
		clock.advance(7);
		takeLatencyPending(PANE)?.();
		expect(getLatencySnapshot(PANE).echoMs).toBe(7);
	});

	it("falls back to ping only when echo is absent or stale", () => {
		const clock = useClock();
		recordLatencyPing(PANE, 40);
		expect(getLatencySnapshot(PANE)).toEqual({ echoMs: 40, source: "ping" });
		sample(clock, 10);
		expect(getLatencySnapshot(PANE)).toEqual({ echoMs: 10, source: "echo" });
		// >30s idle: echo median is stale, ping takes over on refresh.
		clock.advance(31_000);
		refreshLatencySnapshot(PANE);
		expect(getLatencySnapshot(PANE)).toEqual({ echoMs: 40, source: "ping" });
	});

	it("reports idle only after 30s without typing", () => {
		const clock = useClock();
		expect(isLatencyIdle(PANE)).toBe(true); // never typed
		markLatencyInput(PANE, "a");
		expect(isLatencyIdle(PANE)).toBe(false);
		clock.advance(31_000);
		expect(isLatencyIdle(PANE)).toBe(true);
	});

	it("notifies subscribers when the reading changes", () => {
		const clock = useClock();
		let notified = 0;
		const unsubscribe = subscribeLatency(PANE, () => {
			notified += 1;
		});
		sample(clock, 10);
		expect(notified).toBe(1);
		sample(clock, 10); // median unchanged → no notify
		expect(notified).toBe(1);
		unsubscribe();
		sample(clock, 90);
		expect(notified).toBe(1);
	});
});
