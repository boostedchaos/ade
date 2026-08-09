/**
 * tmux-style key names → the bytes a PTY expects.
 *
 * The CLI does the encoding (not the server) so that `ade send-key` and the
 * Feature-4 tmux shim share one table, and so the wire carries unambiguous
 * bytes. The request still carries the original name for logging: the server
 * writes `data` and never re-parses `key`.
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

export class UnknownKeyError extends Error {
	constructor(key: string) {
		super(`Unknown key name: ${key}`);
		this.name = "UnknownKeyError";
	}
}

function encodeCtrl(rest: string): string {
	const lower = rest.toLowerCase();
	const special = CTRL_SPECIALS[lower] ?? CTRL_SPECIALS[rest];
	if (special !== undefined) return special;
	if (/^[a-z]$/.test(lower)) {
		return String.fromCharCode(lower.charCodeAt(0) - 96);
	}
	throw new UnknownKeyError(`C-${rest}`);
}

/**
 * Encodes one tmux-style key name. Accepts `Enter`, `C-c`, `M-x`, `C-M-a`,
 * a bare printable character, or a named key (case-insensitive).
 */
export function encodeKey(key: string): string {
	if (key.length === 0) throw new UnknownKeyError(key);

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
		body = encodeCtrl(rest);
	} else {
		const named = NAMED_KEYS[rest.toLowerCase()];
		if (named !== undefined) {
			body = named;
		} else if ([...rest].length === 1) {
			body = rest;
		} else {
			throw new UnknownKeyError(key);
		}
	}

	return meta ? ESC + body : body;
}

/** Every named key `ade send-key --help` advertises. */
export function knownKeyNames(): string[] {
	return Object.keys(NAMED_KEYS);
}
