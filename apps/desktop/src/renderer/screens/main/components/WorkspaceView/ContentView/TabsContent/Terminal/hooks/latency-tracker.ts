/**
 * Keystroke→paint latency tracker (issue #59).
 *
 * Framework-free module-level state, keyed by paneId, so the two ends of a
 * sample can live where the pipeline already runs without threading props
 * through Terminal.tsx:
 *
 * - `markLatencyInput` is called from useTerminalConnection's write funnel
 *   (AFTER the read-only mirror guard, so mirrors never produce samples).
 * - `takeLatencyPending` is called from useTerminalStream's data handler;
 *   the returned resolver is invoked on the next paint after xterm has
 *   consumed the chunk (rAF inside the xterm.write callback).
 *
 * `useTerminalLatency` subscribes to this state and adds the idle
 * terminal.ping fallback. Measurement is entirely passive — nothing is ever
 * injected into the stream.
 */

/** Writes longer than this are pastes/staged commands, not keystrokes. */
const MAX_KEYSTROKE_BYTES = 6;
/** Rolling window: median over the last N keystroke→paint samples. */
const SAMPLE_WINDOW = 20;
/**
 * A stamp with no output for this long is not going to be echoed (e.g. a
 * program reading with echo off) — discard it unrecorded rather than let a
 * much-later unrelated chunk resolve it into a garbage sample.
 */
const PENDING_STALE_MS = 2000;
/** After this long without typing, the echo median is stale → ping fallback. */
export const LATENCY_IDLE_FALLBACK_MS = 30_000;

export interface TerminalLatencySnapshot {
	/** Rolling median keystroke→paint (or ping round trip) in ms. */
	echoMs: number | null;
	/** Which measurement echoMs currently reflects. */
	source: "echo" | "ping" | null;
}

const NULL_SNAPSHOT: TerminalLatencySnapshot = { echoMs: null, source: null };

interface PaneLatencyState {
	/** performance.now() of the in-flight keystroke, if any (single-in-flight). */
	pendingStamp: number | null;
	/** Last keystroke-sized write, for the idle gate. 0 = never typed. */
	lastInputAt: number;
	/** Newest-last ring of resolved samples, capped at SAMPLE_WINDOW. */
	samples: number[];
	echoMedianMs: number | null;
	/** When the last echo sample resolved. 0 = never. */
	lastEchoSampleAt: number;
	pingMs: number | null;
	listeners: Set<() => void>;
	snapshot: TerminalLatencySnapshot;
}

const panes = new Map<string, PaneLatencyState>();

// Injectable clock so bun tests can exercise time-dependent paths (stale
// discard, idle gate) without real sleeps.
let now = () => performance.now();

function ensurePane(paneId: string): PaneLatencyState {
	let state = panes.get(paneId);
	if (!state) {
		state = {
			pendingStamp: null,
			lastInputAt: 0,
			samples: [],
			echoMedianMs: null,
			lastEchoSampleAt: 0,
			pingMs: null,
			listeners: new Set(),
			snapshot: NULL_SNAPSHOT,
		};
		panes.set(paneId, state);
	}
	return state;
}

function median(sorted: number[]): number {
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[mid]
		: (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeSnapshot(state: PaneLatencyState): TerminalLatencySnapshot {
	const t = now();
	const echoFresh =
		state.echoMedianMs !== null &&
		t - Math.max(state.lastEchoSampleAt, state.lastInputAt) <=
			LATENCY_IDLE_FALLBACK_MS;
	if (state.echoMedianMs !== null && echoFresh) {
		return { echoMs: state.echoMedianMs, source: "echo" };
	}
	if (state.pingMs !== null) {
		return { echoMs: state.pingMs, source: "ping" };
	}
	// Stale echo median beats showing nothing (no ping measured yet).
	if (state.echoMedianMs !== null) {
		return { echoMs: state.echoMedianMs, source: "echo" };
	}
	return NULL_SNAPSHOT;
}

function publish(state: PaneLatencyState): void {
	const next = computeSnapshot(state);
	if (
		next.echoMs === state.snapshot.echoMs &&
		next.source === state.snapshot.source
	) {
		return;
	}
	state.snapshot = next;
	for (const listener of state.listeners) listener();
}

/**
 * Stamp a user keystroke written to the pane. Call ONLY on the writer path
 * (after the read-only mirror guard). Oversized writes (paste, staged
 * commands) are ignored. Single-in-flight, first-wins: while a sample is
 * pending, later keystrokes are not stamped, so a later keystroke can never
 * be paired with an earlier echo (which would under-report).
 */
export function markLatencyInput(paneId: string, data: string): void {
	if (data.length === 0 || data.length > MAX_KEYSTROKE_BYTES) return;
	const state = ensurePane(paneId);
	const t = now();
	state.lastInputAt = t;
	if (state.pendingStamp !== null && t - state.pendingStamp <= PENDING_STALE_MS) {
		return;
	}
	// No pending sample, or the pending one went stale (no echo) — replace.
	state.pendingStamp = t;
}

/**
 * Called by the stream data handler for each incoming chunk. Returns a
 * resolver when a keystroke sample is pending (invoke it on the next paint,
 * i.e. requestAnimationFrame inside the xterm.write callback), or null when
 * there is nothing to measure — the caller then takes the plain write path
 * with zero added overhead.
 */
export function takeLatencyPending(paneId: string): (() => void) | null {
	const state = panes.get(paneId);
	if (!state || state.pendingStamp === null) return null;
	const stamp = state.pendingStamp;
	state.pendingStamp = null;
	if (now() - stamp > PENDING_STALE_MS) return null; // too old to be the echo
	return () => {
		const sample = now() - stamp;
		state.samples.push(sample);
		if (state.samples.length > SAMPLE_WINDOW) state.samples.shift();
		state.echoMedianMs = median([...state.samples].sort((a, b) => a - b));
		state.lastEchoSampleAt = now();
		publish(state);
	};
}

/** Record an idle-fallback terminal.ping round trip. */
export function recordLatencyPing(paneId: string, ms: number): void {
	const state = ensurePane(paneId);
	state.pingMs = ms;
	publish(state);
}

/**
 * True when the pane has seen no typing (and no echo sample) for the idle
 * window — the gate for running the terminal.ping fallback.
 */
export function isLatencyIdle(paneId: string): boolean {
	const state = panes.get(paneId);
	if (!state) return true;
	return (
		now() - Math.max(state.lastInputAt, state.lastEchoSampleAt) >
		LATENCY_IDLE_FALLBACK_MS
	);
}

/**
 * Re-derive the snapshot from the clock (echo freshness decays with time
 * even when no event fires). Called by the hook's interval.
 */
export function refreshLatencySnapshot(paneId: string): void {
	const state = panes.get(paneId);
	if (state) publish(state);
}

export function subscribeLatency(
	paneId: string,
	listener: () => void,
): () => void {
	const state = ensurePane(paneId);
	state.listeners.add(listener);
	return () => {
		state.listeners.delete(listener);
	};
}

export function getLatencySnapshot(paneId: string): TerminalLatencySnapshot {
	return panes.get(paneId)?.snapshot ?? NULL_SNAPSHOT;
}

/** Test-only: drop a pane's state. */
export function resetLatencyForTests(paneId: string): void {
	panes.delete(paneId);
}

/** Test-only: replace the clock. Pass undefined to restore performance.now. */
export function setLatencyNowForTests(fn?: () => number): void {
	now = fn ?? (() => performance.now());
}
