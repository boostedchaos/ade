import { ControlError } from "./protocol";

/**
 * SERVER-SIDE FALLBACK key encoding.
 *
 * The CLI is the primary encoder: `ade send-key` sends `{pane, key, data}`
 * where `data` is already the byte sequence, and the server writes `data`
 * verbatim without re-parsing `key` (see commands/terminal.ts). This table
 * exists only for callers that send `key` WITHOUT `data` — the tmux shim in an
 * older revision, a hand-written socket client, a test.
 *
 * Because it is a second copy of a table that must agree with the CLI's, it is
 * a deliberate mirror of `packages/cli/src/keys.ts`: same named keys including
 * the tmux aliases, same control specials, same both-orders modifier parsing.
 * `keys-contract.test.ts` asserts the two agree for every name the CLI knows
 * and fails if either side drifts. Change one, change both.
 *
 * Escapes are written as \u00XX on purpose — literal control bytes in source
 * are invisible in review and get mangled by formatters.
 */

const ESC = "\u001b";
const DEL = "\u007f";

/** Named keys, looked up case-insensitively. tmux aliases included. */
const NAMED_KEYS: Record<string, string> = {
	enter: "\r",
	return: "\r",
	cr: "\r",
	lf: "\n",
	newline: "\n",
	tab: "\t",
	btab: `${ESC}[Z`,
	escape: ESC,
	esc: ESC,
	space: " ",
	bspace: DEL,
	backspace: DEL,
	up: `${ESC}[A`,
	down: `${ESC}[B`,
	right: `${ESC}[C`,
	left: `${ESC}[D`,
	home: `${ESC}[H`,
	end: `${ESC}[F`,
	pageup: `${ESC}[5~`,
	ppage: `${ESC}[5~`,
	pagedown: `${ESC}[6~`,
	npage: `${ESC}[6~`,
	insert: `${ESC}[2~`,
	ic: `${ESC}[2~`,
	delete: `${ESC}[3~`,
	dc: `${ESC}[3~`,
	f1: `${ESC}OP`,
	f2: `${ESC}OQ`,
	f3: `${ESC}OR`,
	f4: `${ESC}OS`,
	f5: `${ESC}[15~`,
	f6: `${ESC}[17~`,
	f7: `${ESC}[18~`,
	f8: `${ESC}[19~`,
	f9: `${ESC}[20~`,
	f10: `${ESC}[21~`,
	f11: `${ESC}[23~`,
	f12: `${ESC}[24~`,
};

/** Control-modified keys that are not simply letter → charCode - 96. */
const CTRL_SPECIALS: Record<string, string> = {
	" ": "\u0000",
	space: "\u0000",
	"@": "\u0000",
	"[": "\u001b",
	"\\": "\u001c",
	"]": "\u001d",
	"^": "\u001e",
	_: "\u001f",
	"?": DEL,
};

function encodeCtrl(rest: string, original: string): string {
	const lower = rest.toLowerCase();
	const special = CTRL_SPECIALS[lower] ?? CTRL_SPECIALS[rest];
	if (special !== undefined) return special;
	if (/^[a-z]$/.test(lower)) {
		return String.fromCharCode(lower.charCodeAt(0) - 96);
	}
	throw new ControlError("BAD_REQUEST", `Unknown key name: ${original}`);
}

/**
 * Encode one tmux-style key name. Accepts `Enter`, `C-c`, `M-x`, `C-M-a`, a
 * bare printable character, or a named key (case-insensitive).
 *
 * Throws ControlError(BAD_REQUEST) where the CLI throws UnknownKeyError; the
 * contract test treats "both sides reject it" as agreement.
 */
export function resolveKeySequence(key: string): string {
	if (key.length === 0) {
		throw new ControlError("BAD_REQUEST", `Unknown key name: ${key}`);
	}

	let rest = key;
	let meta = false;
	let ctrl = false;

	// Modifier prefixes may appear in either order: C-M-a and M-C-a.
	for (;;) {
		const prefix = rest.slice(0, 2).toUpperCase();
		if (prefix === "C-" && rest.length > 2) {
			ctrl = true;
			rest = rest.slice(2);
			continue;
		}
		if (prefix === "M-" && rest.length > 2) {
			meta = true;
			rest = rest.slice(2);
			continue;
		}
		break;
	}

	let body: string;
	if (ctrl) {
		body = encodeCtrl(rest, key);
	} else {
		const named = NAMED_KEYS[rest.toLowerCase()];
		if (named !== undefined) {
			body = named;
		} else if ([...rest].length === 1) {
			body = rest;
		} else {
			throw new ControlError("BAD_REQUEST", `Unknown key name: ${key}`);
		}
	}

	return meta ? ESC + body : body;
}

/** Every named key this fallback table knows. Used by the contract test. */
export function knownKeyNames(): string[] {
	return Object.keys(NAMED_KEYS);
}
