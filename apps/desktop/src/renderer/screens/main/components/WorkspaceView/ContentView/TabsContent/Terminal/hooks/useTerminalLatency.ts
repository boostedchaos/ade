import { useEffect, useSyncExternalStore } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import {
	getLatencySnapshot,
	isLatencyIdle,
	recordLatencyPing,
	refreshLatencySnapshot,
	subscribeLatency,
	type TerminalLatencySnapshot,
} from "./latency-tracker";

/** How often to re-evaluate freshness / run the idle ping fallback. */
const PING_INTERVAL_MS = 10_000;

export type UseTerminalLatencyReturn = TerminalLatencySnapshot;

/**
 * Keystroke→paint latency for a pane (issue #59).
 *
 * Primary metric (what the user feels): each keystroke written to the pane
 * is stamped in useTerminalConnection's write funnel and resolved on the
 * next paint after the next stream data chunk (rAF after the xterm.write
 * callback, in useTerminalStream). `echoMs` is the rolling median of the
 * last ~20 samples — TUI repaints make individual samples noisy, so median,
 * not EWMA. Read-only mirrors write nothing, so they produce no samples.
 *
 * Fallback: when the pane has seen no typing for >30s the median is stale,
 * so a `terminal.ping` mutation (client→server→daemon round trip, riding
 * the same WS transport keystrokes use) is measured instead and reported
 * with `source: "ping"`.
 *
 * Nothing is ever injected into the terminal stream.
 */
export function useTerminalLatency(paneId: string): UseTerminalLatencyReturn {
	const snapshot = useSyncExternalStore(
		(listener) => subscribeLatency(paneId, listener),
		() => getLatencySnapshot(paneId),
	);

	useEffect(() => {
		let cancelled = false;
		let inFlight = false;

		const tick = () => {
			// Echo freshness decays with wall time even without events.
			refreshLatencySnapshot(paneId);
			if (cancelled || inFlight || !isLatencyIdle(paneId)) return;
			inFlight = true;
			const started = performance.now();
			electronTrpcClient.terminal.ping
				.mutate()
				.then(() => {
					if (!cancelled) {
						recordLatencyPing(paneId, performance.now() - started);
					}
				})
				.catch(() => {
					// Server unreachable — keep whatever reading we had.
				})
				.finally(() => {
					inFlight = false;
				});
		};

		const id = setInterval(tick, PING_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [paneId]);

	return snapshot;
}
