import type { AcpPaneEvent } from "lib/trpc/routers/acp";
import { create } from "zustand";

/** The protocol update carried by an `update` event, without re-importing it. */
type AcpUpdate = Extract<AcpPaneEvent, { type: "update" }>["update"];

/**
 * The pane's conversation, and the pure reducer that builds it.
 *
 * Accumulation is a pure function of (state, event) so the whole of the pane's
 * rendering logic is testable without Electron, IPC, an adapter, or a login.
 * The reducer keys on `update.kind`, so a kind a future adapter version adds
 * costs a new member of the switch and nothing else.
 *
 * Phase 3 (D1) widened `AcpEntry` from a text-only shape to a discriminated
 * union — tool cards and thinking blocks are entries; plan and usage are
 * store-level, because both replace wholesale rather than accumulating.
 */

/** The protocol shapes, taken off the union rather than re-imported. */
type AcpToolCall = Extract<AcpUpdate, { kind: "tool_call" }>["toolCall"];
type AcpToolCallUpdate = Extract<
	AcpUpdate,
	{ kind: "tool_call_update" }
>["toolCall"];
export type AcpPlanEntry = Extract<
	AcpUpdate,
	{ kind: "plan" }
>["entries"][number];
export type AcpCost = Extract<AcpUpdate, { kind: "usage_update" }>["cost"];
export type AcpToolCallContent = NonNullable<AcpToolCall["content"]>[number];

/**
 * The two blocked-on-a-human requests (B2), taken off the pane-event union for
 * the same reason the update shapes are: the host owns these types and a
 * re-import would let the two drift.
 */
type AcpPermissionEvent = Extract<AcpPaneEvent, { type: "permission_request" }>;
type AcpElicitationEvent = Extract<
	AcpPaneEvent,
	{ type: "elicitation_request" }
>;
export type AcpPermissionOption = AcpPermissionEvent["options"][number];
export type AcpElicitationForm = AcpElicitationEvent["form"];
export type AcpElicitationField = AcpElicitationForm["fields"][number];
export type AcpElicitationOption = NonNullable<
	AcpElicitationField["options"]
>[number];

export type AcpEntryRole =
	| "user"
	| "assistant"
	| "divider"
	| "tool"
	| "thinking"
	| "request";

export interface AcpTextEntry {
	id: string;
	role: "user" | "assistant" | "divider";
	text: string;
	/** Assistant entries only: false while the turn is still streaming. */
	closed?: boolean;
	/** Assistant entries only: the `stopReason` the turn ended with. */
	stopReason?: string;
}

/**
 * The latest-wins merge of every frame seen for one `toolCallId`.
 *
 * Every field is optional because the wire's initial `tool_call` carries only
 * a generic title and the refinements fill the rest in: a field this state
 * does not have is a field no frame has carried, never a default we invented.
 */
export interface AcpToolCallState {
	toolCallId: string;
	title?: string;
	kind?: AcpToolCall["kind"];
	status?: AcpToolCall["status"];
	content?: NonNullable<AcpToolCall["content"]>;
	locations?: NonNullable<AcpToolCall["locations"]>;
	rawInput?: unknown;
	rawOutput?: unknown;
	/** `_meta.claudeCode.toolName` — the programmatic name; `name` is never set. */
	toolName?: string;
}

export interface AcpToolEntry {
	id: string;
	role: "tool";
	toolCallId: string;
	call: AcpToolCallState;
	/** The card was created by an update for an id no `tool_call` announced. */
	synthetic?: boolean;
	/**
	 * Never set. Declared so `entry.text` stays readable across the whole union
	 * as `string | undefined` — a tool card has no text of its own, and every
	 * caller that wants one already narrows on `role` first.
	 */
	text?: undefined;
}

export interface AcpThinkingEntry {
	id: string;
	role: "thinking";
	text: string;
}

/**
 * The agent is blocked on the user, in the scrollback where it happened (B2).
 *
 * Permission and elicitation are one entry type rather than two because the
 * card's whole lifecycle — appear pending, disable on answer, show what was
 * chosen, go stale when the session dies — is identical for both, and only the
 * body differs.
 */
export interface AcpRequestState {
	requestId: string;
	kind: "permission" | "elicitation";
	/** The tool's title, or the agent's prose question. */
	title: string;
	/** Permission only: `_meta.claudeCode.toolName`, when supplied. */
	toolName?: string;
	/** Permission only. */
	options?: AcpPermissionOption[];
	/** Elicitation only. */
	form?: AcpElicitationForm;
}

/**
 * How a request stopped waiting.
 *
 * `unavailable` is the case worth a member of its own: the request was settled
 * by something OTHER than this user — a cancelled turn, a dead session, a
 * double-click that lost the race — and the card must say so rather than sit
 * enabled offering a button that can no longer do anything.
 */
export type AcpRequestOutcome =
	| { kind: "answered"; summary: string }
	| { kind: "declined" }
	| { kind: "unavailable"; reason: string };

export interface AcpRequestEntry {
	id: string;
	role: "request";
	request: AcpRequestState;
	/** Null while it still waits on the user. */
	outcome: AcpRequestOutcome | null;
	/** Never set; see `AcpToolEntry.text`. */
	text?: undefined;
}

export type AcpEntry =
	| AcpTextEntry
	| AcpToolEntry
	| AcpThinkingEntry
	| AcpRequestEntry;

type AcpEntryInput =
	| Omit<AcpTextEntry, "id">
	| Omit<AcpToolEntry, "id">
	| Omit<AcpThinkingEntry, "id">
	| Omit<AcpRequestEntry, "id">;

export interface AcpUsage {
	used: number;
	size: number;
	cost: AcpCost;
}

export interface AcpTranscript {
	entries: AcpEntry[];
	/**
	 * Index into `entries` of the assistant message currently being streamed
	 * into, or null. Kept as an index rather than an object reference so the
	 * reducer stays a plain value transform.
	 */
	openIndex: number | null;
	/** Same, for the thinking entry consecutive thought chunks append to. */
	openThinkingIndex: number | null;
	/**
	 * Same, for the user entry consecutive `user_message_chunk`s append to (A3).
	 *
	 * Only a replay produces these — a live turn's user text is appended by
	 * `appendUserPrompt` when the user presses send, and the adapter does not
	 * echo it back (`acp-agent.js:2657-2664`).
	 */
	openUserIndex: number | null;
	/** `toolCallId` → index into `entries`, so an update correlates in O(1). */
	toolCallIdToEntry: Record<string, number>;
	/** Same, for `requestId` → the permission/elicitation card that carries it. */
	requestIdToEntry: Record<string, number>;
	/** The whole plan, replaced by every `plan` frame. Null until one arrives. */
	plan: AcpPlanEntry[] | null;
	/** The latest `usage_update`. */
	usage: AcpUsage | null;
	/**
	 * The last NON-null cost seen. `cost` is null on every frame but the
	 * turn-final one, so reading it off `usage` alone would blank the figure
	 * the moment the next turn starts.
	 */
	lastCost: AcpCost;
	/**
	 * Update kinds nothing renders, counted by kind. Counted rather than
	 * dropped so a kind nobody handled can never throw, and so `unknown` — what
	 * a future adapter version's new kind arrives as — stays visible.
	 */
	ignoredKinds: Record<string, number>;
	/** Monotonic id source; kept in state so the reducer stays deterministic. */
	nextId: number;
}

export function emptyTranscript(): AcpTranscript {
	return {
		entries: [],
		openIndex: null,
		openThinkingIndex: null,
		openUserIndex: null,
		toolCallIdToEntry: {},
		requestIdToEntry: {},
		plan: null,
		usage: null,
		lastCost: null,
		ignoredKinds: {},
		nextId: 1,
	};
}

function withEntry(
	state: AcpTranscript,
	entry: AcpEntryInput,
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
		index === state.openIndex && entry.role === "assistant"
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
	const withUser = withEntry(closeUser(state), { role: "user", text });
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
			return closeOpen(closeUser(closeThinking(state)), event.stopReason);
		case "turn_error":
			return appendDivider(
				closeOpen(closeUser(closeThinking(state))),
				event.message,
			);
		case "session_exit":
			return {
				...settleAllPending(
					appendDivider(
						closeOpen(closeUser(closeThinking(state))),
						event.expected
							? "Session closed."
							: `Session ended — exit code ${event.code ?? "unknown"}${
									event.signal ? ` (${event.signal})` : ""
								}`,
					),
					"Session ended before this was answered.",
				),
				// Everything scoped to the child that just died goes with it. The
				// plan is its plan (D4); `usage`/`lastCost` are per-SESSION by the
				// SDK's own definition, so carrying them into a new session states
				// the dead one's numbers as the live one's; and a surviving
				// `toolCallIdToEntry` lets the next session's reused toolCallId merge
				// into a card ABOVE the divider, reverting a completed card to
				// pending. The entries and the divider STAY: the divider is what
				// separates the generations.
				plan: null,
				usage: null,
				lastCost: null,
				toolCallIdToEntry: {},
				// Settled above, then dropped for the same reason: the next
				// session mints request ids from its own counter, and a surviving
				// entry would let `req-1` reopen a card above the divider.
				requestIdToEntry: {},
			};
		case "session_error":
			return {
				...settleAllPending(
					appendDivider(
						closeOpen(closeUser(closeThinking(state))),
						event.message,
					),
					"Session ended before this was answered.",
				),
				// Same fact as `session_exit`, reached by a crash instead of a
				// clean stop, so it drops the request index for the same reason
				// (A11/F5): the next session mints `req-1` from its own counter
				// and a surviving entry would reopen the card above the divider.
				requestIdToEntry: {},
			};
		case "permission_request":
			return appendRequest(state, {
				requestId: event.requestId,
				kind: "permission",
				title: event.title,
				options: event.options,
				...(event.toolName ? { toolName: event.toolName } : {}),
			});
		case "elicitation_request":
			return appendRequest(state, {
				requestId: event.requestId,
				kind: "elicitation",
				title: event.message,
				form: event.form,
			});
		case "events_dropped":
			// A divider, not a silent drop: a truncated conversation and a whole
			// one look identical, and this is the only thing that says which one
			// the user is reading.
			return appendDivider(
				state,
				`${event.count} ${event.count === 1 ? "event" : "events"} dropped`,
			);
		default:
			return state;
	}
}

/**
 * A new blocked-on-a-human card, at the bottom of the scrollback.
 *
 * Closes the open text entries first, for the reason `appendThinking` does:
 * assistant text still flowing into an earlier entry would otherwise render
 * BELOW a card that arrived before it.
 */
function appendRequest(
	state: AcpTranscript,
	request: AcpRequestState,
): AcpTranscript {
	const existing = state.requestIdToEntry[request.requestId];
	// Ids are minted per session by `AcpSession`, so a duplicate is a re-delivery
	// (a buffer drain racing a live emit), never a second question.
	if (existing !== undefined) return state;

	const closed = closeThinking(closeUser(closeOpen(state)));
	const opened = withEntry(closed, { role: "request", request, outcome: null });
	return {
		...opened.state,
		requestIdToEntry: {
			...opened.state.requestIdToEntry,
			[request.requestId]: opened.index,
		},
	};
}

/**
 * Record how one request was settled.
 *
 * First-wins for an answer — the first click is the one that reached the agent
 * — with ONE exception: an `unavailable` outcome always wins, because it is
 * the wire reporting that the answer did NOT land (a cancelled turn, a dead
 * session, a double-click that lost the race). The pane answers optimistically
 * so the buttons disable immediately, and that optimism must be correctable by
 * the only thing that knows better.
 */
export function settleRequest(
	state: AcpTranscript,
	requestId: string,
	outcome: AcpRequestOutcome,
): AcpTranscript {
	const index = state.requestIdToEntry[requestId];
	if (index === undefined) return state;
	const entry = state.entries[index];
	if (entry?.role !== "request") return state;
	if (entry.outcome && outcome.kind !== "unavailable") return state;

	const entries = state.entries.map((candidate, at) =>
		at === index && candidate.role === "request"
			? { ...candidate, outcome }
			: candidate,
	);
	return { ...state, entries };
}

/**
 * Every still-pending card goes stale when the session dies: the host rejects
 * the wire requests on teardown, so the buttons cannot do anything any more
 * and a card that still offers them is lying about what a click will do.
 */
function settleAllPending(state: AcpTranscript, reason: string): AcpTranscript {
	let next = state;
	for (const [requestId, index] of Object.entries(state.requestIdToEntry)) {
		// PENDING only. `unavailable` outruns an existing outcome by design
		// (above), which would otherwise rewrite a card the user really did
		// answer into one that never got through.
		const entry = state.entries[index];
		if (entry?.role !== "request" || entry.outcome) continue;
		next = settleRequest(next, requestId, { kind: "unavailable", reason });
	}
	return next;
}

function appendDivider(state: AcpTranscript, text: string): AcpTranscript {
	return withEntry(state, { role: "divider", text }).state;
}

function reduceUpdate(
	incoming: AcpTranscript,
	update: AcpUpdate,
): AcpTranscript {
	// Anything that is not more user text ends the user entry, so a later
	// replayed user turn opens a fresh one instead of appending across whatever
	// the agent did in between. Done here rather than per-case so a kind added
	// later cannot forget it.
	const state =
		update.kind === "user_message_chunk" ? incoming : closeUser(incoming);

	switch (update.kind) {
		case "user_message_chunk":
			return appendUserText(state, update.text);
		case "agent_message_chunk":
			return appendAssistantText(closeThinking(state), update.text);
		case "agent_thought_chunk":
			return appendThinking(state, update.text);
		case "tool_call":
			return applyToolCall(closeThinking(state), update.toolCall, false);
		case "tool_call_update":
			return applyToolCall(closeThinking(state), update.toolCall, true);
		case "plan":
			// Every frame carries the complete list, so this replaces wholesale.
			return { ...state, plan: update.entries };
		case "usage_update":
			return {
				...state,
				usage: { used: update.used, size: update.size, cost: update.cost },
				lastCost: update.cost ?? state.lastCost,
			};
		default:
			return countIgnored(state, update.kind);
	}
}

function countIgnored(state: AcpTranscript, kind: string): AcpTranscript {
	return {
		...state,
		ignoredKinds: {
			...state.ignoredKinds,
			[kind]: (state.ignoredKinds[kind] ?? 0) + 1,
		},
	};
}

function appendAssistantText(
	state: AcpTranscript,
	text: string,
): AcpTranscript {
	if (state.openIndex === null) {
		// Unsolicited output (a session-start banner, a turn we did not open, the
		// reply text resuming after a tool card) is DISPLAYED, never dropped: a
		// pane that silently discards agent text is indistinguishable from a
		// broken subscription.
		const opened = withEntry(state, {
			role: "assistant",
			text,
			closed: false,
		});
		return { ...opened.state, openIndex: opened.index };
	}

	const entries = state.entries.map((entry, index) =>
		index === state.openIndex && entry.role === "assistant"
			? { ...entry, text: entry.text + text }
			: entry,
	);
	return { ...state, entries };
}

/**
 * Consecutive thought chunks append to one entry; anything that produces
 * another entry closes it, so a later thought opens a fresh block rather than
 * appending across whatever the agent did in between.
 */
function appendThinking(state: AcpTranscript, text: string): AcpTranscript {
	if (state.openThinkingIndex === null) {
		// A thinking block appended below an OPEN assistant entry would render
		// above text that arrives after it, because that text keeps flowing into
		// the earlier entry. Closing first is what keeps entry order = arrival
		// order for every non-text entry.
		const closed = closeOpen(state);
		const opened = withEntry(closed, { role: "thinking", text });
		return { ...opened.state, openThinkingIndex: opened.index };
	}

	const entries = state.entries.map((entry, index) =>
		index === state.openThinkingIndex && entry.role === "thinking"
			? { ...entry, text: entry.text + text }
			: entry,
	);
	return { ...state, entries };
}

function closeThinking(state: AcpTranscript): AcpTranscript {
	if (state.openThinkingIndex === null) return state;
	return { ...state, openThinkingIndex: null };
}

/**
 * Consecutive `user_message_chunk`s append to one entry, exactly the way
 * assistant text does (A3).
 *
 * This is how a `session/load` replay reconstructs the user's half of the
 * conversation: the frames are ordinary updates carrying no marker, so the
 * reducer cannot tell a replayed turn from a live one — and does not need to.
 */
function appendUserText(state: AcpTranscript, text: string): AcpTranscript {
	if (state.openUserIndex === null) {
		// Close the assistant and thinking entries first, for the same reason
		// `appendThinking` does: text still flowing into an earlier open entry
		// would render below an entry that arrived after it.
		const closed = closeThinking(closeOpen(state));
		const opened = withEntry(closed, { role: "user", text });
		return { ...opened.state, openUserIndex: opened.index };
	}

	const entries = state.entries.map((entry, index) =>
		index === state.openUserIndex && entry.role === "user"
			? { ...entry, text: entry.text + text }
			: entry,
	);
	return { ...state, entries };
}

function closeUser(state: AcpTranscript): AcpTranscript {
	if (state.openUserIndex === null) return state;
	return { ...state, openUserIndex: null };
}

/**
 * Sparse merge, keyed by `toolCallId`.
 *
 * An absent field means unchanged and a present `content` / `locations`
 * REPLACES the collection — the adapter re-sends a whole diff rather than a
 * delta, so appending would show an edit twice. `null` counts as absent: the
 * protocol says omitting a field and sending null both mean "leave it".
 */
function mergeToolCall(
	base: AcpToolCallState,
	patch: AcpToolCall | AcpToolCallUpdate,
): AcpToolCallState {
	const next: AcpToolCallState = { ...base };
	if (patch.title != null) next.title = patch.title;
	if (patch.kind != null) next.kind = patch.kind;
	if (patch.status != null) next.status = patch.status;
	if (patch.content != null) next.content = patch.content;
	if (patch.locations != null) next.locations = patch.locations;
	if (patch.rawInput != null) next.rawInput = patch.rawInput;
	if (patch.rawOutput != null) next.rawOutput = patch.rawOutput;
	const toolName = readToolName(patch);
	if (toolName) next.toolName = toolName;
	return next;
}

/** `ToolCall.name` is never set on this wire; the real name is in `_meta`. */
function readToolName(patch: AcpToolCall | AcpToolCallUpdate): string | null {
	if (typeof patch.name === "string" && patch.name) return patch.name;
	const claudeCode = (
		patch._meta as { claudeCode?: unknown } | null | undefined
	)?.claudeCode;
	const toolName = (claudeCode as { toolName?: unknown } | undefined)?.toolName;
	return typeof toolName === "string" && toolName ? toolName : null;
}

function applyToolCall(
	state: AcpTranscript,
	patch: AcpToolCall | AcpToolCallUpdate,
	isUpdate: boolean,
): AcpTranscript {
	const index = state.toolCallIdToEntry[patch.toolCallId];
	const existing = index === undefined ? undefined : state.entries[index];

	if (existing?.role === "tool") {
		// A FULL `tool_call` frame for an id we already have a card for is a
		// replay, not news: the adapter announces each id exactly once, so the
		// duplicate carries the opening frame's generic title, `pending` status
		// and empty collections — all non-null, so merging it would revert the
		// title, un-complete the card and wipe the content the refinements
		// filled in. Nothing upstream sends one today; a session/load replay or
		// an adapter bump is one step away from it. Updates are unaffected —
		// they are how the wire keeps talking about a card, including after it
		// completes.
		if (!isUpdate) return state;

		const entries = state.entries.map((entry, at) =>
			at === index && entry.role === "tool"
				? { ...entry, call: mergeToolCall(entry.call, patch) }
				: entry,
		);
		return { ...state, entries };
	}

	// An update for an id no `tool_call` announced still gets a card: dropping
	// it would hide real work, and the wire is the only thing that decides
	// whether we ever saw the opening frame.
	const closed = closeOpen(state);
	const opened = withEntry(closed, {
		role: "tool",
		toolCallId: patch.toolCallId,
		call: mergeToolCall({ toolCallId: patch.toolCallId }, patch),
		...(isUpdate ? { synthetic: true } : {}),
	});
	return {
		...opened.state,
		toolCallIdToEntry: {
			...opened.state.toolCallIdToEntry,
			[patch.toolCallId]: opened.index,
		},
	};
}

// =============================================================================
// Per-pane store
// =============================================================================

interface AcpTranscriptStore {
	byPane: Record<string, AcpTranscript>;
	get: (paneId: string) => AcpTranscript;
	apply: (paneId: string, event: AcpPaneEvent) => void;
	promptSent: (paneId: string, text: string) => void;
	/** Record how a permission/elicitation card stopped waiting (B2). */
	settleRequest: (
		paneId: string,
		requestId: string,
		outcome: AcpRequestOutcome,
	) => void;
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
	settleRequest: (paneId, requestId, outcome) =>
		set((state) => ({
			byPane: {
				...state.byPane,
				[paneId]: settleRequest(
					state.byPane[paneId] ?? emptyTranscript(),
					requestId,
					outcome,
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
