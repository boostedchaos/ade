/**
 * Output Coalescer
 *
 * Micro-coalesces PTY output before it is framed onto stdout (issue #58).
 *
 * Algorithm: the first queued chunk arms a short coalescing timer
 * (2ms by default — was a fixed 32ms batch). Every additional chunk that
 * arrives within the window rides the SAME timer, so bursts of small chunks
 * (Ink/claude repaints: erase-line + rewrite in the same millisecond) flush
 * as ONE frame. The first chunk is deliberately NOT flushed synchronously —
 * that would ship torn partial repaints mid-burst.
 *
 * A size force-flush (128KB by default) bounds memory and latency under
 * flood; it clears any armed timer so a stale timer cannot fire later and
 * ship a premature partial next batch.
 *
 * Timer functions are injectable for deterministic unit tests.
 */

export interface OutputCoalescerOptions {
	/** Receives the joined batch and how many chunks were coalesced into it. */
	flush: (data: string, chunkCount: number) => void;
	/** Idle-coalesce window in ms. Default 2. */
	coalesceMs?: number;
	/** Force-flush threshold in bytes. Default 128KB. */
	maxBatchBytes?: number;
	setTimeoutFn?: (callback: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
}

export interface OutputCoalescer {
	/** Queue a chunk. May force-flush synchronously if maxBatchBytes is hit. */
	push(data: string): void;
	/** Clear any armed timer and flush pending data (no-op when empty). */
	flushNow(): void;
	/** Clear any armed timer and drop pending data without flushing. */
	reset(): void;
}

export const DEFAULT_OUTPUT_COALESCE_MS = 2;
export const DEFAULT_MAX_OUTPUT_BATCH_SIZE_BYTES = 128 * 1024;

export function createOutputCoalescer(
	options: OutputCoalescerOptions,
): OutputCoalescer {
	const coalesceMs = options.coalesceMs ?? DEFAULT_OUTPUT_COALESCE_MS;
	const maxBatchBytes =
		options.maxBatchBytes ?? DEFAULT_MAX_OUTPUT_BATCH_SIZE_BYTES;
	const setTimeoutFn =
		options.setTimeoutFn ??
		((callback: () => void, ms: number) => setTimeout(callback, ms));
	const clearTimeoutFn =
		options.clearTimeoutFn ??
		((handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>));

	// CRITICAL: array buffering to avoid O(n²) string concatenation.
	let chunks: string[] = [];
	let bytesQueued = 0;
	let timer: unknown = null;

	function clearTimer(): void {
		if (timer !== null) {
			clearTimeoutFn(timer);
			timer = null;
		}
	}

	function emit(): void {
		if (chunks.length === 0) return;
		const data = chunks.join("");
		const chunkCount = chunks.length;
		chunks = [];
		bytesQueued = 0;
		options.flush(data, chunkCount);
	}

	return {
		push(data: string): void {
			chunks.push(data);
			bytesQueued += Buffer.byteLength(data, "utf8");

			if (bytesQueued >= maxBatchBytes) {
				// Force-flush: must clear any armed timer so it cannot fire
				// later and prematurely ship a partial next batch.
				clearTimer();
				emit();
				return;
			}

			if (timer === null) {
				timer = setTimeoutFn(() => {
					timer = null;
					emit();
				}, coalesceMs);
			}
		},

		flushNow(): void {
			clearTimer();
			emit();
		},

		reset(): void {
			clearTimer();
			chunks = [];
			bytesQueued = 0;
		},
	};
}
