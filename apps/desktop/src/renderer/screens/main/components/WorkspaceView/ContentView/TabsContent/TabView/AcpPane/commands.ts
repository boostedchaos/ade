import type { AcpPaneEvent } from "lib/trpc/routers/acp";
import { create } from "zustand";
import type { AcpPaneLifecycle } from "./AcpStatusLine";

/**
 * The pane's slash commands, and the pure logic the palette is built from.
 *
 * Same split as `controlBar.ts`: every value transform here is DOM-free, so
 * filtering, the seeding rule and the trigger test are testable without React.
 *
 * The invariant worth stating: an EVENT always replaces the list, while the
 * mount seed applies only when nothing is held. `session/new` does not return
 * commands — they arrive solely as a notification — so a pane that mounts after
 * that notification fired must be able to seed from the host's cache, and a
 * seed that could overwrite a live event would put a stale snapshot on screen
 * (D2).
 */

/** The command shape the host carries, without re-importing the SDK. */
export type AcpCommand = Extract<
	Extract<AcpPaneEvent, { type: "update" }>["update"],
	{ kind: "available_commands_update" }
>["commands"][number];

export interface AcpCommandsState {
	commands: AcpCommand[];
}

export function emptyCommands(): AcpCommandsState {
	return { commands: [] };
}

/**
 * Seed from `acp.state` on mount — but only into an empty list.
 *
 * The snapshot and the event stream are separate IPC channels with nothing
 * ordering them against each other. Refusing the seed once anything is held is
 * what makes the race benign without a generation counter (D1/D2).
 */
export function seedCommands(
	state: AcpCommandsState,
	commands: AcpCommand[],
): AcpCommandsState {
	if (state.commands.length > 0) return state;
	return { commands };
}

/** Pure (state, event) → state. Never throws, for any event. */
export function reduceCommandsEvent(
	state: AcpCommandsState,
	event: AcpPaneEvent,
): AcpCommandsState {
	switch (event.type) {
		case "update":
			// Wholesale replacement, the same semantics the plan and config lists
			// use — this is how a disabled skill disappears from the palette.
			return event.update.kind === "available_commands_update"
				? { commands: event.update.commands }
				: state;
		case "session_exit":
			// Per-session data (D5). The next session repopulates from its own
			// state and events.
			return emptyCommands();
		default:
			return state;
	}
}

// =============================================================================
// Palette logic
// =============================================================================

/** Descriptions carry a skill's whole trigger blurb — >1 KB observed. */
const DESCRIPTION_MAX = 120;

/** One line, hard-truncated: a row must never grow the palette. */
export function commandSummary(description: string | null | undefined): string {
	if (!description) return "";
	const line = description.split("\n")[0]?.trim() ?? "";
	return line.length > DESCRIPTION_MAX
		? `${line.slice(0, DESCRIPTION_MAX - 1)}…`
		: line;
}

/** The hint the accepted command declares for its argument, if any. */
export function commandHint(command: AcpCommand): string | null {
	return command.input?.hint ?? null;
}

/**
 * Case-insensitive: an EXACT name match first, then prefix matches, then
 * substring matches, each in reported order. An empty query is the whole list.
 *
 * The exact tier is not a nicety (A1). The live list holds names that are
 * prefixes of other names — `loop`/`loop-library`, `usage`/`usage-credits` —
 * so without it a fully typed name sorts behind a longer one and Enter runs a
 * command the user never asked for.
 */
export function filterCommands(
	commands: AcpCommand[],
	query: string,
): AcpCommand[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return commands;
	const exact: AcpCommand[] = [];
	const prefix: AcpCommand[] = [];
	const substring: AcpCommand[] = [];
	for (const command of commands) {
		const name = command.name.toLowerCase();
		if (name === needle) exact.push(command);
		else if (name.startsWith(needle)) prefix.push(command);
		else if (name.includes(needle)) substring.push(command);
	}
	return [...exact, ...prefix, ...substring];
}

/** End of the leading `/token`, i.e. the first whitespace or end of text. */
function firstTokenEnd(text: string): number {
	const match = /\s/.exec(text);
	return match ? match.index : text.length;
}

/**
 * The query the palette should show, or null when it must stay shut.
 *
 * Commands are line-initial, so the text has to START with `/` — a `/` inside a
 * sentence (a path, a date) must not open a palette. The caret has to still be
 * inside that first token: once the user has moved past it they are typing
 * arguments, not choosing a command. Caret 0 sits BEFORE the slash and does not
 * count.
 */
export function slashQuery(text: string, caret: number): string | null {
	if (!text.startsWith("/")) return null;
	if (caret < 1 || caret > firstTokenEnd(text)) return null;
	return text.slice(1, firstTokenEnd(text));
}

/**
 * Replace the leading token with `/name`, keeping any arguments already typed.
 *
 * With nothing after the token a trailing space is added, so the palette closes
 * on its own trigger rule rather than needing a separate "just accepted" flag.
 */
export function acceptCommand(
	text: string,
	name: string,
): { text: string; caret: number } {
	const rest = text.slice(firstTokenEnd(text));
	const inserted = `/${name}`;
	return {
		text: rest.length > 0 ? inserted + rest : `${inserted} `,
		caret: inserted.length + 1,
	};
}

/**
 * Keep the highlight inside the list that is actually on screen (A5).
 *
 * The highlight resets on a QUERY change, and a command update can shrink the
 * matches without the query moving an inch — a disabled skill does exactly
 * that. Deriving the index rather than resetting it means the stale value can
 * never reach `matches[selected]`.
 */
export function clampSelected(selected: number, length: number): number {
	if (length <= 0) return 0;
	return Math.min(Math.max(selected, 0), length - 1);
}

/**
 * What an empty palette says, keyed on the session rather than on the length
 * (A4).
 *
 * `session_exit` clears the list (D5), so length alone tells a DEAD session it
 * is still loading — forever. D4's whole point is that empty and broken must be
 * distinguishable; that distinction lives in the lifecycle, not the array.
 *
 * `idle` is unreachable from `AcpPane` today (it starts at `starting`), but it
 * means "no session", not "the session ended", and saying so costs one line.
 */
export function emptyPaletteMessage(lifecycle: AcpPaneLifecycle): string {
	switch (lifecycle) {
		case "dead":
			return "session ended — commands unavailable";
		case "idle":
			return "no session — commands unavailable";
		default:
			return "commands not loaded yet";
	}
}

/** The command whose argument hint is currently on offer. */
export interface ActiveHint {
	name: string;
	hint: string;
}

/**
 * Whether the accepted command's argument hint should be on screen (A2).
 *
 * It cannot be the textarea's placeholder: accepting always leaves `/name `, a
 * placeholder paints only an EMPTY textarea, so that variant renders never. The
 * rule is instead "the hinted command is still the leading token and its
 * arguments are still empty" — which also retires the hint by itself when the
 * user edits the name into something else.
 */
export function hintVisible(active: ActiveHint | null, text: string): boolean {
	if (!active) return false;
	const end = firstTokenEnd(text);
	if (text.slice(0, end) !== `/${active.name}`) return false;
	return text.slice(end).trim().length === 0;
}

/** ~8 rows: the ceiling the design asks for when the pane has room. */
export const PALETTE_MAX_PX = 240;
/** ~3 rows: below this a palette is not worth opening, so it scrolls instead. */
export const PALETTE_MIN_PX = 84;

/**
 * Cap the palette to the space measured above the composer (A3).
 *
 * Every pane clips its children, and the palette grows UPWARD — so a panel
 * taller than the room above loses its TOP rows, which are the best matches.
 * Pure in the measured number so the arithmetic is testable without a layout;
 * the measuring itself is the composer's job.
 *
 * A non-finite measurement means nothing could be measured — fall back to the
 * ceiling rather than pinning the palette shut.
 */
export function paletteMaxHeight(spaceAbovePx: number): number {
	if (!Number.isFinite(spaceAbovePx)) return PALETTE_MAX_PX;
	return Math.max(
		PALETTE_MIN_PX,
		Math.min(PALETTE_MAX_PX, Math.floor(spaceAbovePx)),
	);
}

// =============================================================================
// Per-pane store
// =============================================================================

interface AcpCommandsStore {
	byPane: Record<string, AcpCommandsState>;
	get: (paneId: string) => AcpCommandsState;
	apply: (paneId: string, event: AcpPaneEvent) => void;
	seed: (paneId: string, commands: AcpCommand[]) => void;
	clear: (paneId: string) => void;
}

function update(
	paneId: string,
	transform: (state: AcpCommandsState) => AcpCommandsState,
) {
	return (store: { byPane: Record<string, AcpCommandsState> }) => ({
		byPane: {
			...store.byPane,
			[paneId]: transform(store.byPane[paneId] ?? emptyCommands()),
		},
	});
}

export const useAcpCommandsStore = create<AcpCommandsStore>((set, get) => ({
	byPane: {},
	get: (paneId) => get().byPane[paneId] ?? emptyCommands(),
	apply: (paneId, event) =>
		set(update(paneId, (state) => reduceCommandsEvent(state, event))),
	seed: (paneId, commands) =>
		set(update(paneId, (state) => seedCommands(state, commands))),
	clear: (paneId) =>
		set((store) => {
			const byPane = { ...store.byPane };
			delete byPane[paneId];
			return { byPane };
		}),
}));
