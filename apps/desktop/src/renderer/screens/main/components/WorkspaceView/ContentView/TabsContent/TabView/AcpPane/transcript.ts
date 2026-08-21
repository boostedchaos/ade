import type { AcpPaneEvent } from "lib/trpc/routers/acp";
import { create } from "zustand";

/** The protocol update carried by an `update` event, without re-importing it. */
type AcpUpdate = Extract<AcpPaneEvent, { type: "update" }>["update"];

/**
 * The pane's conversation, and the pure reducer that builds it.
 *
 * Accumulation is a pure function of (state, event) so the whole of Phase 2's
 * rendering logic is testable without Electron, IPC, an adapter, or a login.
 * The reducer keys on `update.kind`, so Phase 3 adds MEMBERS to the switch
 * rather than restructuring anything.
 */

export type AcpEntryRole = "user" | "assistant" | "divider";

export interface AcpEntry {
	id: string;
	role: AcpEntryRole;
	text: string;
	/** Assistant entries only: false while the turn is still streaming. */
	closed?: boolean;
	/** Assistant entries only: the `stopReason` the turn ended with. */
	stopReason?: string;
}

export interface AcpTranscript {
	entries: AcpEntry[];
	/**
	 * Index into `entries` of the assistant message currently being streamed
	 * into, or null. Kept as an index rather than an object reference so the
	 * reducer stays a plain value transform.
	 */
	openIndex: number | null;
	/**
	 * Update kinds Phase 2 does not render, counted by kind. Counted rather than
	 * dropped for two reasons: it is the cheapest possible proof the stream is
	 * carrying more than text (Phases 3-5 are renderer-only work against it),
	 * and a kind nobody handled must never be able to throw.
	 */
	ignoredKinds: Record<string, number>;
	/** Monotonic id source; kept in state so the reducer stays deterministic. */
	nextId: number;
}

export function emptyTranscript(): AcpTranscript {
	return { entries: [], openIndex: null, ignoredKinds: {}, nextId: 1 };
}

function withEntry(
	state: AcpTranscript,
	entry: Omit<AcpEntry, "id">,
): { state: AcpTranscript; index: number } {
	const entries = [...state.entries, { ...entry, id: `e${state.nextId}` }];
	return {
		state: { ...state, entries, nextId: state.nextId + 1 },
		index: entries.length - 1,
	};
}

function closeOpen(state: AcpTranscript, stopReason?: string): AcpTranscript {
	if (state.openIndex === null) return { ...state, openIndex: null };
	const entries = state.entries.map((entry, index) =>
		index === state.openIndex
			? { ...entry, closed: true, ...(stopReason ? { stopReason } : {}) }
			: entry,
	);
	return { ...state, entries, openIndex: null };
}

/** The user pressed send. Appends their message and opens an assistant reply. */
export function appendUserPrompt(
	state: AcpTranscript,
	text: string,
): AcpTranscript {
	const withUser = withEntry(state, { role: "user", text });
	const withAssistant = withEntry(withUser.state, {
		role: "assistant",
		text: "",
		closed: false,
	});
	return { ...withAssistant.state, openIndex: withAssistant.index };
}

/** Pure (state, event) → state. Never throws, for any event. */
export function reduceAcpEvent(
	state: AcpTranscript,
	event: AcpPaneEvent,
): AcpTranscript {
	switch (event.type) {
		case "update":
			return reduceUpdate(state, event.update);
		case "turn_end":
			return closeOpen(state, event.stopReason);
		case "turn_error":
			return appendDivider(closeOpen(state), event.message);
		case "session_exit":
			return appendDivider(
				closeOpen(state),
				event.expected
					? "Session closed."
					: `Session ended — exit code ${event.code ?? "unknown"}${
							event.signal ? ` (${event.signal})` : ""
						}`,
			);
		case "session_error":
			return appendDivider(closeOpen(state), event.message);
		default:
			return state;
	}
}

function appendDivider(state: AcpTranscript, text: string): AcpTranscript {
	return withEntry(state, { role: "divider", text }).state;
}

function reduceUpdate(state: AcpTranscript, update: AcpUpdate): AcpTranscript {
	if (update.kind !== "agent_message_chunk") {
		// Counted, not rendered, and never thrown on — including `unknown`, which
		// is what a future adapter version's new kind arrives as.
		return {
			...state,
			ignoredKinds: {
				...state.ignoredKinds,
				[update.kind]: (state.ignoredKinds[update.kind] ?? 0) + 1,
			},
		};
	}

	if (state.openIndex === null) {
		// Unsolicited output (a session-start banner, a turn we did not open) is
		// DISPLAYED, never dropped: a pane that silently discards agent text is
		// indistinguishable from a broken subscription.
		const opened = withEntry(state, {
			role: "assistant",
			text: update.text,
			closed: false,
		});
		return { ...opened.state, openIndex: opened.index };
	}

	const entries = state.entries.map((entry, index) =>
		index === state.openIndex
			? { ...entry, text: entry.text + update.text }
			: entry,
	);
	return { ...state, entries };
}

// =============================================================================
// Per-pane store
// =============================================================================

interface AcpTranscriptStore {
	byPane: Record<string, AcpTranscript>;
	get: (paneId: string) => AcpTranscript;
	apply: (paneId: string, event: AcpPaneEvent) => void;
	promptSent: (paneId: string, text: string) => void;
	clear: (paneId: string) => void;
}

/**
 * In-memory only, deliberately NOT `persist`-backed: writing every streamed
 * chunk into persisted storage would rewrite it on every token and grow
 * without bound (D3).
 */
export const useAcpTranscriptStore = create<AcpTranscriptStore>((set, get) => ({
	byPane: {},
	get: (paneId) => get().byPane[paneId] ?? emptyTranscript(),
	apply: (paneId, event) =>
		set((state) => ({
			byPane: {
				...state.byPane,
				[paneId]: reduceAcpEvent(
					state.byPane[paneId] ?? emptyTranscript(),
					event,
				),
			},
		})),
	promptSent: (paneId, text) =>
		set((state) => ({
			byPane: {
				...state.byPane,
				[paneId]: appendUserPrompt(
					state.byPane[paneId] ?? emptyTranscript(),
					text,
				),
			},
		})),
	clear: (paneId) =>
		set((state) => {
			const byPane = { ...state.byPane };
			delete byPane[paneId];
			return { byPane };
		}),
}));
