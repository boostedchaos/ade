import type { TabsState } from "../app-state/schemas";
import { getControlPlaneEvents } from "./index";

/**
 * `pane-created` / `pane-closed` / `pane-focused`, derived by diffing the tabs
 * mirror.
 *
 * WHY THE MIRROR AND NOT THE BRIDGE REPLY. The renderer-bridge reply path knows
 * the op kind and the pane it produced, so emitting there would have been
 * fewer lines — but it only ever sees CLI-initiated changes. The mirror is the
 * single choke point every layout mutation passes through (`ui-state.tabs.set`,
 * written by the renderer's zustand persist middleware on every change), so a
 * diff here also covers the user splitting a pane with the mouse, closing a tab,
 * or clicking into another pane. `ade events --kinds pane-focused` is only
 * useful to an agent if it reports what the HUMAN did too.
 *
 * Focus is reported per tab, which is what the store models: `focusedPaneIds`
 * is tabId → paneId, and a tab keeps its own focused pane while it is in the
 * background. Consumers get `tabId` on every event and can filter.
 *
 * Panes that appear and disappear inside a single mutation are invisible here,
 * as are the intermediate states of a batched mutation — a diff reports net
 * change, not a transaction log. Nothing in the spec asks for the latter.
 */

/** Only what a diff needs; accepts an absent mirror (first boot). */
type MirrorLike = Pick<TabsState, "panes" | "focusedPaneIds"> | undefined;

export interface PaneEvent {
	kind: "pane-created" | "pane-closed" | "pane-focused";
	data: Record<string, unknown>;
}

/** Pure so it can be tested without a server, a window, or app state. */
export function diffPaneEvents(
	previous: MirrorLike,
	next: MirrorLike,
): PaneEvent[] {
	const events: PaneEvent[] = [];
	const before = previous?.panes ?? {};
	const after = next?.panes ?? {};

	for (const [paneId, pane] of Object.entries(after)) {
		if (before[paneId]) continue;
		events.push({
			kind: "pane-created",
			data: { paneId, tabId: pane.tabId, type: pane.type },
		});
	}

	for (const [paneId, pane] of Object.entries(before)) {
		if (after[paneId]) continue;
		events.push({
			kind: "pane-closed",
			data: { paneId, tabId: pane.tabId, type: pane.type },
		});
	}

	const focusBefore = previous?.focusedPaneIds ?? {};
	const focusAfter = next?.focusedPaneIds ?? {};
	for (const [tabId, paneId] of Object.entries(focusAfter)) {
		if (!paneId || focusBefore[tabId] === paneId) continue;
		events.push({ kind: "pane-focused", data: { paneId, tabId } });
	}

	return events;
}

/**
 * Publishes the diff between the mirror as it stands and the value about to
 * replace it. Call from `ui-state.tabs.set` BEFORE the assignment — the stored
 * value at that moment IS the previous state, which is why no baseline has to
 * be retained here (and why a restart cannot replay every existing pane as
 * newly created).
 *
 * Never throws: failing to publish an event must not fail the layout mutation
 * that caused it.
 */
export function publishPaneEvents(
	previous: TabsState | undefined,
	next: TabsState | undefined,
): void {
	try {
		const bus = getControlPlaneEvents();
		if (!bus) return;
		for (const event of diffPaneEvents(previous, next)) {
			bus.emit(event.kind, event.data);
		}
	} catch (error) {
		console.error(
			"[control-plane] pane event diff failed:",
			error instanceof Error ? error.message : error,
		);
	}
}
