import type { ControlEvent, ControlEventKind } from "./protocol";

export type ControlEventListener = (event: ControlEvent) => void;

/**
 * Fan-out for subscribed connections.
 *
 * Every kind reaches this bus by someone calling emit() with it — no change
 * here and no wire change per producer, which is the point of keeping the kind
 * set open in protocol.ts. Current producers, all in the desktop app:
 * pane-created / pane-closed / pane-focused from the tabs-mirror diff
 * (main/lib/control-plane/pane-events.ts), agent-state-changed from the agent
 * session registry, notification from the attention store.
 */
export class ControlEventBus {
	private listeners = new Set<{
		kinds: Set<ControlEventKind> | "all";
		fn: ControlEventListener;
	}>();

	subscribe(
		kinds: ControlEventKind[] | "all",
		fn: ControlEventListener,
	): () => void {
		const entry = {
			kinds: kinds === "all" ? ("all" as const) : new Set(kinds),
			fn,
		};
		this.listeners.add(entry);
		return () => {
			this.listeners.delete(entry);
		};
	}

	emit(kind: ControlEventKind, data: Record<string, unknown>): void {
		const event: ControlEvent = {
			event: kind,
			ts: new Date().toISOString(),
			data,
		};
		for (const entry of this.listeners) {
			if (entry.kinds !== "all" && !entry.kinds.has(kind)) continue;
			try {
				entry.fn(event);
			} catch {
				// A broken subscriber must not stop delivery to the others.
			}
		}
	}

	get subscriberCount(): number {
		return this.listeners.size;
	}
}
