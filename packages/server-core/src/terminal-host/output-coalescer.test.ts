import { describe, expect, it } from "bun:test";
import {
	createOutputCoalescer,
	DEFAULT_MAX_OUTPUT_BATCH_SIZE_BYTES,
	DEFAULT_OUTPUT_COALESCE_MS,
} from "./output-coalescer";

interface FakeTimer {
	callback: () => void;
	ms: number;
	cleared: boolean;
}

/**
 * Deterministic harness: timers are captured, never auto-fire.
 * `fire(i)` simulates the timer elapsing (respects cleared state, like the
 * real clearTimeout would).
 */
function createHarness(
	overrides: { coalesceMs?: number; maxBatchBytes?: number } = {},
) {
	const flushes: Array<{ data: string; chunkCount: number }> = [];
	const timers: FakeTimer[] = [];

	const coalescer = createOutputCoalescer({
		flush: (data, chunkCount) => {
			flushes.push({ data, chunkCount });
		},
		setTimeoutFn: (callback, ms) => {
			const timer: FakeTimer = { callback, ms, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimeoutFn: (handle) => {
			(handle as FakeTimer).cleared = true;
		},
		...overrides,
	});

	return {
		coalescer,
		flushes,
		timers,
		fire(index: number): void {
			const timer = timers[index];
			if (timer && !timer.cleared) timer.callback();
		},
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("output coalescer (timer behavior, deterministic)", () => {
	it("does NOT flush a small first chunk synchronously; arms a 2ms timer", () => {
		const h = createHarness();

		h.coalescer.push("a");

		expect(h.flushes.length).toBe(0); // no synchronous flush (torn Ink repaints)
		expect(h.timers.length).toBe(1);
		expect(h.timers[0].ms).toBe(DEFAULT_OUTPUT_COALESCE_MS);
		expect(h.timers[0].ms).toBe(2);
	});

	it("a burst of small chunks within the window rides ONE timer and flushes as ONE frame", () => {
		const h = createHarness();

		h.coalescer.push("\x1b[2K"); // erase-line
		h.coalescer.push("\x1b[G");
		h.coalescer.push("rewritten line");

		expect(h.timers.length).toBe(1); // additional chunks did not re-arm
		expect(h.flushes.length).toBe(0);

		h.fire(0);

		expect(h.flushes.length).toBe(1);
		expect(h.flushes[0].data).toBe("\x1b[2K\x1b[Grewritten line");
		expect(h.flushes[0].chunkCount).toBe(3);
	});

	it("timer fire with an empty queue emits nothing", () => {
		const h = createHarness();
		h.coalescer.push("a");
		h.fire(0);
		expect(h.flushes.length).toBe(1);
		// Callback ran; queue now empty. A hypothetical second fire is a no-op.
		h.timers[0].callback();
		expect(h.flushes.length).toBe(1);
	});

	it("a chunk arriving after a flush arms a FRESH timer", () => {
		const h = createHarness();
		h.coalescer.push("first");
		h.fire(0);
		h.coalescer.push("second");

		expect(h.timers.length).toBe(2);
		h.fire(1);
		expect(h.flushes.length).toBe(2);
		expect(h.flushes[1].data).toBe("second");
	});

	it("reaching maxBatchBytes force-flushes immediately (128KB default intact)", () => {
		const h = createHarness();
		const big = "x".repeat(DEFAULT_MAX_OUTPUT_BATCH_SIZE_BYTES); // 128KB

		h.coalescer.push(big);

		expect(h.flushes.length).toBe(1); // synchronous, no timer wait
		expect(h.flushes[0].data.length).toBe(128 * 1024);
		expect(h.timers.length).toBe(0); // never armed a timer for this batch
	});

	it("force-flush CLEARS the armed timer, and the stale timer emits nothing", () => {
		const h = createHarness({ maxBatchBytes: 100 });

		h.coalescer.push("small"); // arms timer
		expect(h.timers.length).toBe(1);

		h.coalescer.push("y".repeat(200)); // crosses threshold -> force-flush

		expect(h.flushes.length).toBe(1);
		expect(h.flushes[0].data).toBe(`small${"y".repeat(200)}`);
		expect(h.flushes[0].chunkCount).toBe(2);
		expect(h.timers[0].cleared).toBe(true); // the armed timer was cleared

		// Even if the stale callback somehow ran, it must not emit a frame
		// or disturb a subsequent batch.
		h.timers[0].callback();
		expect(h.flushes.length).toBe(1);

		h.coalescer.push("next");
		expect(h.timers.length).toBe(2); // fresh timer, not relying on stale one
		h.fire(1);
		expect(h.flushes.length).toBe(2);
		expect(h.flushes[1].data).toBe("next");
	});

	it("counts BYTES (multi-byte UTF-8), not string length, toward the force-flush threshold", () => {
		const h = createHarness({ maxBatchBytes: 4 });

		h.coalescer.push("é"); // 1 char, 2 bytes
		expect(h.flushes.length).toBe(0);

		h.coalescer.push("é"); // 4 bytes total -> force-flush
		expect(h.flushes.length).toBe(1);
		expect(h.flushes[0].data).toBe("éé");
	});

	it("flushNow clears the armed timer and emits pending data; empty flushNow is a no-op", () => {
		const h = createHarness();

		h.coalescer.push("exit-tail");
		h.coalescer.flushNow();

		expect(h.flushes.length).toBe(1);
		expect(h.flushes[0].data).toBe("exit-tail");
		expect(h.timers[0].cleared).toBe(true);

		h.coalescer.flushNow(); // nothing pending -> no empty frame
		expect(h.flushes.length).toBe(1);
	});

	it("reset drops pending data without flushing and clears the timer", () => {
		const h = createHarness();

		h.coalescer.push("doomed");
		h.coalescer.reset();

		expect(h.flushes.length).toBe(0);
		expect(h.timers[0].cleared).toBe(true);

		h.coalescer.flushNow();
		expect(h.flushes.length).toBe(0);
	});
});

describe("output coalescer (real timers)", () => {
	it("a small chunk flushes ~2ms after arrival (not synchronously, well before the old 32ms)", async () => {
		const flushTimes: number[] = [];
		const coalescer = createOutputCoalescer({
			flush: () => {
				flushTimes.push(performance.now());
			},
		});

		const start = performance.now();
		coalescer.push("hello");
		expect(flushTimes.length).toBe(0); // not synchronous

		// Loaded CI runners add 10ms+ of timer jitter (observed 18ms on the
		// Windows runner), so the wait and the upper bound stay well clear of
		// the 2ms window while still proving we beat the old 32ms batch. The
		// deterministic fake-timer tests above pin the exact 2ms delay.
		await sleep(25);

		expect(flushTimes.length).toBe(1);
		const elapsed = flushTimes[0] - start;
		expect(elapsed).toBeGreaterThanOrEqual(1); // waited for the window
		expect(elapsed).toBeLessThan(30); // under the old 32ms batch
	});

	it("flood: sustained small-chunk output coalesces (flush count well below push count, no runaway rate)", async () => {
		let flushCount = 0;
		let flushedBytes = 0;
		const coalescer = createOutputCoalescer({
			flush: (data) => {
				flushCount += 1;
				flushedBytes += data.length;
			},
		});

		// Simulate a `yes`-style flood: many small chunks arriving faster than
		// the 2ms window, across ~60ms of wall time.
		const chunk = "y\n".repeat(16); // 32 bytes per chunk
		let pushes = 0;
		const start = performance.now();
		while (performance.now() - start < 60) {
			for (let i = 0; i < 20; i++) {
				coalescer.push(chunk);
				pushes += 1;
			}
			await sleep(0); // let armed timers fire between arrival waves
		}
		coalescer.flushNow();

		expect(flushedBytes).toBe(pushes * chunk.length); // nothing lost
		expect(flushCount).toBeGreaterThan(0);
		// Coalescing must hold under flood: bounded by ~1 flush per 2ms window
		// (plus the final flushNow), NOT one message per chunk.
		expect(flushCount).toBeLessThan(pushes / 4);
		expect(flushCount).toBeLessThanOrEqual(Math.ceil(60 / 2) + 2);
	});
});
