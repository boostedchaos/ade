import {
	optionalBoolean,
	optionalPositiveInt,
	optionalString,
	requireString,
} from "../args";
import { resolveKeySequence } from "../keys";
import { ControlError } from "../protocol";
import type { CommandRegistry } from "../server";
import { requirePane } from "../snapshot";
import { resolveTarget } from "../target-resolution";

/**
 * Terminal I/O group. These go main → terminal-host daemon directly (through
 * the app's existing TerminalRuntime, which is the same client machinery the
 * tRPC terminal router uses); no renderer hop, per SPEC.
 *
 * READ LIMITATION — stated because a wrong screen read is worse than none.
 * `read-screen` / `capture-pane` are served from the pane's PERSISTED
 * scrollback (`~/.ade[-ws]/terminal-history/<workspaceId>/<paneId>/`), not
 * from the daemon's @xterm/headless emulator. Two consequences:
 *   1. What you get is the output STREAM the PTY produced, replayed with ANSI
 *      stripped — not a rendered screen. A full-screen/alt-screen TUI (Claude
 *      Code's own interface, vim, htop) will read as the raw redraw traffic
 *      flattened, not as what is on screen.
 *   2. It lags by the history writer's flush.
 * The accurate source is the daemon's serialized snapshot, but the only way to
 * obtain it today is `createOrAttach`, which RESIZES a live session to the
 * caller's requested dimensions (terminal-host.ts, the `else` branch of
 * createOrAttach) — i.e. reading would mutate the user's terminal. Getting a
 * true rendered screen needs a new read-only `snapshot` request on the daemon,
 * which is outside this lane's file ownership. Flagged for the next phase.
 */

// Built from named constants via `new RegExp` rather than written as literals:
// Biome's noControlCharactersInRegex rejects a raw ESC in a regex literal, and
// terminal-escape-filter.ts already establishes this ESC-constant idiom.
const ESC = "\x1b";
const BEL = "\x07";

/** OSC <text> terminated by BEL or by ST (ESC \). */
const OSC_PATTERN = new RegExp(
	`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
	"g",
);
/** CSI <params> <intermediates> <final byte>. */
const CSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
/** Remaining two-byte escapes (ESC followed by one @-Z or \\-_). */
const ESC_PATTERN = new RegExp(`${ESC}[@-Z\\\\-_]`, "g");

/** Strip CSI/OSC/ESC sequences so a scrollback dump is readable as text. */
export function stripAnsi(input: string): string {
	return (
		input
			.replace(OSC_PATTERN, "")
			.replace(CSI_PATTERN, "")
			.replace(ESC_PATTERN, "")
			// A CR that only precedes a LF is line-ending noise, not a redraw.
			.replace(/\r(?=\n)/g, "")
	);
}

/** Last `count` non-empty-trailing lines of a text blob. */
export function lastLines(text: string, count: number): string {
	const lines = text.split("\n");
	while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
		lines.pop();
	}
	return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function resolvePaneAndWorkspace(
	session: Parameters<CommandRegistry[string]>[0],
	args: Record<string, unknown>,
): { paneId: string; workspaceId: string } {
	const snapshot = session.host.getSnapshot();
	const paneId = resolveTarget(
		snapshot,
		"pane",
		optionalString(args, "pane") ?? "focused",
	);
	const pane = requirePane(snapshot, paneId);
	const tab = snapshot.tabs.find((t) => t.id === pane.tabId);
	if (!tab) {
		throw new ControlError("NOT_FOUND", `Pane ${paneId} has no tab`);
	}
	if (pane.type !== "terminal") {
		throw new ControlError(
			"BAD_REQUEST",
			`Pane ${paneId} is a ${pane.type} pane, not a terminal`,
		);
	}
	return { paneId, workspaceId: tab.workspaceId };
}

export const terminalCommands: CommandRegistry = {
	send: (session, args) => {
		const { paneId } = resolvePaneAndWorkspace(session, args);
		const text = requireString(args, "text");
		// `--enter` appends a carriage return, which is what almost every caller
		// wants and is easy to forget; default false keeps `send` literal.
		const data = optionalBoolean(args, "enter", false) ? `${text}\r` : text;
		session.host.terminal.write(paneId, data);
		return { paneId, bytes: Buffer.byteLength(data, "utf8") };
	},

	/**
	 * The CLI encodes the key and sends `{pane, key, data}`; `data` is
	 * authoritative and is written verbatim without re-parsing `key`, so one
	 * table (the CLI's) owns the encoding and the tmux shim in Feature 4 shares
	 * it. `key` still travels for logging and error messages.
	 *
	 * The `key`-only path is a FALLBACK for callers that omit `data` — a
	 * hand-written socket client, a test. keys-contract.test.ts pins the
	 * fallback table to the CLI's so the two cannot diverge silently.
	 */
	"send-key": (session, args) => {
		const { paneId } = resolvePaneAndWorkspace(session, args);
		const key = requireString(args, "key");
		const data = optionalString(args, "data");
		const encodedBy = data !== undefined ? "client" : "server";
		const sequence = data !== undefined ? data : resolveKeySequence(key);
		session.host.terminal.write(paneId, sequence);
		return { paneId, key, encodedBy };
	},

	"read-screen": async (session, args) => {
		const { paneId, workspaceId } = resolvePaneAndWorkspace(session, args);
		const lines = optionalPositiveInt(args, "lines") ?? 50;
		const raw = await session.host.terminal.readScrollback(workspaceId, paneId);
		if (raw === null) {
			throw new ControlError(
				"NOT_FOUND",
				`No recorded output for pane ${paneId}`,
			);
		}
		const text = lastLines(stripAnsi(raw), lines);
		return { paneId, lines, text, source: "scrollback-history" };
	},

	"capture-pane": async (session, args) => {
		const { paneId, workspaceId } = resolvePaneAndWorkspace(session, args);
		const raw = await session.host.terminal.readScrollback(workspaceId, paneId);
		if (raw === null) {
			throw new ControlError(
				"NOT_FOUND",
				`No recorded output for pane ${paneId}`,
			);
		}
		const keepAnsi = optionalBoolean(args, "raw", false);
		return {
			paneId,
			text: keepAnsi ? raw : stripAnsi(raw),
			source: "scrollback-history",
		};
	},
};
