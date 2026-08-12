import { useMemo } from "react";
import { useTabsStore } from "renderer/stores";
import type { Pane } from "shared/tabs-types";

/**
 * Fleet-wide agent status, counted across every open pane.
 *
 * Feeds the titlebar's live status line (`1 working  1 waiting`, DESIGN-BRIEF
 * §2a) and the blocked-session strip. Both read signals the app already
 * tracks — this adds no persistent state, it only aggregates `pane.status`.
 */
export interface FleetStatus {
	working: number;
	/** Panes in `permission` — "waiting on you" in the design's vocabulary. */
	waiting: number;
	review: number;
	/**
	 * The pane that has been waiting longest, or null when nothing is blocked.
	 * The strip names one agent, so it has to be a deterministic choice rather
	 * than "whichever the object happened to yield first".
	 */
	oldestWaiting: Pane | null;
}

export function useFleetStatus(): FleetStatus {
	const panes = useTabsStore((s) => s.panes);

	return useMemo(() => {
		let working = 0;
		let waiting = 0;
		let review = 0;
		const waitingPanes: Pane[] = [];

		for (const pane of Object.values(panes) as Pane[]) {
			switch (pane.status) {
				case "working":
					working++;
					break;
				case "permission":
					waiting++;
					waitingPanes.push(pane);
					break;
				case "review":
					review++;
					break;
				default:
					break;
			}
		}

		// Pane ids are creation-ordered, so the lowest id among the waiting
		// panes is the one that has been open longest. Sorting by id is stable
		// across re-renders, which matters: the strip must not flip between two
		// blocked agents every time the store updates.
		waitingPanes.sort((a, b) => a.id.localeCompare(b.id));

		return {
			working,
			waiting,
			review,
			oldestWaiting: waitingPanes[0] ?? null,
		};
	}, [panes]);
}
