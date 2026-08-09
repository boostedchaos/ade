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
 * the app's existing client machinery); no renderer hop, per SPEC.
 *
 * SCREEN READS now prefer the daemon's read-only `snapshot` request, which
 * returns the @xterm/headless mirror's RENDERED text — what a human sees,
 * including a correctly composed alt-screen TUI (Claude Code's own interface,
 * vim, htop). Phase 1 could only read persisted scrollback, which is the raw
 * output STREAM and reads as flattened redraw traffic for exactly those cases.
 * The accurate source used to be reachable only via `createOrAttach`, which
 * RESIZES the live session — reading would have mutated the user's terminal.
 * The new request attaches nothing, resizes nothing and writes nothing.
 *
 * Persisted scrollback remains the FALLBACK, and it is still the right answer
 * for a pane whose session the daemon no longer holds (closed pane, daemon
 * restarted): the history file outlives the session. Every response says which
 * source answered, because "the screen right now" and "what was on disk" are
 * different claims and a caller acting on the wrong one would not be able to
 * tell.
 */

/** Which source produced the text in a read response. */
export type ScreenSource = "live-screen" | "scrollback-history";

/**
 * The daemon-backed read, as commands need it. Declared here rather than on
 * `ControlPlaneHost.terminal` because `host.ts` and the desktop adapter that
 * implements it belong to another lane in this phase; probing for the method
 * lets the daemon work land now and start being used the moment the adapter
 * supplies it, instead of the two halves having to merge together.
 *
 * CONSEQUENCE, stated plainly: until the adapter implements `readSnapshot`,
 * every read silently takes the fallback and reports
 * `source: "scrollback-history"` — i.e. Phase 1 behaviour. The `source` field
 * is how you can tell from the outside which half is live.
 */
export interface LiveScreenRead {
	text: string;
	cols: number;
	rows: number;
	scrollbackLines: number;
	alternateScreen: boolean;
	cwd: string | null;
	isAlive: boolean;
	flushed: boolean;
}

interface MaybeSnapshotCapable {
	readSnapshot?: (
		paneId: string,
		options: { includeScrollback?: boolean; maxLines?: number },
	) => Promise<LiveScreenRead | null>;
}

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

/**
 * Strip CSI/OSC/ESC sequences so a raw scrollback dump is readable as text.
 * Only the FALLBACK path needs this — daemon snapshots are already rendered.
 */
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

/**
 * Try the daemon's read-only snapshot. Returns null — meaning "use the
 * fallback" — when the host cannot do it, when the daemon has no such session,
 * or when the request fails for any reason (an older daemon answers with an
 * error). A screen read must degrade to the persisted transcript rather than
 * failing the command.
 */
export async function tryLiveScreenRead(
	terminal: unknown,
	paneId: string,
	options: { includeScrollback?: boolean; maxLines?: number },
	log: (level: "info" | "warn" | "error", message: string) => void,
): Promise<LiveScreenRead | null> {
	const capable = terminal as MaybeSnapshotCapable;
	if (typeof capable.readSnapshot !== "function") return null;
	try {
		return await capable.readSnapshot(paneId, options);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(
			"warn",
			`live screen read failed for ${paneId}, using history: ${message}`,
		);
		return null;
	}
}

export const terminalCommands: CommandRegistry = {
	send: (session, args) => {
		const { paneId } = resolvePaneAndWorkspace(session, args);
		const text = requireString(args, "text");
		// `--enter` appends a carriage return, which is what almost every caller
		// wants and is easy to forget; default false keeps `send` literal.
		const data = optionalBoolean(args, "enter", false) ? `${text}\r` : text;
		try {
			session.host.terminal.write(paneId, data);
		} catch (error) {
			// A pane whose layout row exists but whose PTY has not spawned yet (or
			// has died) is a retryable condition, not a server fault. Reported as
			// NOT_FOUND so a caller can back off and retry instead of treating an
			// INTERNAL as fatal — see `pane-ready` below.
			if (!session.host.terminal.getSession(paneId)?.isAlive) {
				throw new ControlError(
					"NOT_FOUND",
					`Pane ${paneId} has no live terminal session`,
				);
			}
			throw error;
		}
		return { paneId, bytes: Buffer.byteLength(data, "utf8") };
	},

	/**
	 * Is this pane's PTY actually spawned and alive?
	 *
	 * A pane is created in two stages: the renderer's layout store gains the
	 * pane row (which is when a `new-pane`/`new-tab` reply returns), and only
	 * then does the renderer's terminal lifecycle effect ask the daemon to spawn
	 * the PTY. `list-panes` and the layout snapshot see stage one; a `send`
	 * needs stage two. Nothing else on the wire distinguishes them, which is
	 * how a freshly rebuilt pane could be written to before it could accept
	 * writes.
	 *
	 * Backed by the same session map `terminal.write` checks, so a `true` here
	 * is the condition `write` requires and not a proxy for it.
	 */
	"pane-ready": (session, args) => {
		const { paneId } = resolvePaneAndWorkspace(session, args);
		return {
			paneId,
			ready: session.host.terminal.getSession(paneId)?.isAlive === true,
		};
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

	/**
	 * The last N lines of output. `includeScrollback` is set because "the last
	 * 200 lines" means output, not "the viewport, truncated" — and the emulator
	 * ignores the flag on the alternate screen, where the rendered viewport IS
	 * the whole answer and there is no scrollback by definition.
	 */
	"read-screen": async (session, args) => {
		const { paneId, workspaceId } = resolvePaneAndWorkspace(session, args);
		const lines = optionalPositiveInt(args, "lines") ?? 50;

		const live = await tryLiveScreenRead(
			session.host.terminal,
			paneId,
			{ includeScrollback: true, maxLines: lines },
			session.host.log,
		);
		if (live) {
			return {
				paneId,
				lines,
				text: live.text,
				source: "live-screen" satisfies ScreenSource,
				cols: live.cols,
				rows: live.rows,
				alternateScreen: live.alternateScreen,
				isAlive: live.isAlive,
				// False means the pre-read flush timed out under continuous
				// output, so the text is marginally behind. Surfaced rather than
				// hidden, so a caller can distinguish it from a quiet terminal.
				flushed: live.flushed,
			};
		}

		const raw = await session.host.terminal.readScrollback(workspaceId, paneId);
		if (raw === null) {
			throw new ControlError(
				"NOT_FOUND",
				`No live session and no recorded output for pane ${paneId}`,
			);
		}
		return {
			paneId,
			lines,
			text: lastLines(stripAnsi(raw), lines),
			source: "scrollback-history" satisfies ScreenSource,
		};
	},

	/** Everything the pane has, screen plus scrollback. */
	"capture-pane": async (session, args) => {
		const { paneId, workspaceId } = resolvePaneAndWorkspace(session, args);
		const keepAnsi = optionalBoolean(args, "raw", false);

		// `--raw` asks for the escape sequences, which only the persisted stream
		// carries — the daemon read returns rendered text by design. Go straight
		// to history rather than reading the screen and ignoring the flag.
		if (!keepAnsi) {
			const live = await tryLiveScreenRead(
				session.host.terminal,
				paneId,
				{ includeScrollback: true },
				session.host.log,
			);
			if (live) {
				return {
					paneId,
					text: live.text,
					source: "live-screen" satisfies ScreenSource,
					cols: live.cols,
					rows: live.rows,
					scrollbackLines: live.scrollbackLines,
					alternateScreen: live.alternateScreen,
					isAlive: live.isAlive,
					flushed: live.flushed,
				};
			}
		}

		const raw = await session.host.terminal.readScrollback(workspaceId, paneId);
		if (raw === null) {
			throw new ControlError(
				"NOT_FOUND",
				`No live session and no recorded output for pane ${paneId}`,
			);
		}
		return {
			paneId,
			text: keepAnsi ? raw : stripAnsi(raw),
			source: "scrollback-history" satisfies ScreenSource,
		};
	},
};
