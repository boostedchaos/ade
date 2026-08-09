/**
 * tmux argv parsing.
 *
 * Two stages, because tmux's grammar is two-stage: global flags (including the
 * socket selector) come before the verb, and each verb has its own flag table
 * in which the SAME letter can mean different things — `-l` is a value flag on
 * `split-window` (`-l 70%`) and a boolean on `send-keys` (literal mode). A
 * single flat parser would mis-consume one of them, so the tables are per-verb.
 *
 * Contract source: docs/specs/mission-control/probe/PROBE-CONTRACT.md.
 */

export type SocketMode = "S" | "L" | null;

export interface ParsedCommand {
	/** `-S <path>` / `-L <name>` — accepted and ignored; the shim IS the server. */
	socketMode: SocketMode;
	socketValue: string | null;
	/** Verb, or "" when argv carried only global flags. */
	verb: string;
	/** argv after the verb. */
	rest: string[];
}

/** Global flags taking a value, consumed before the verb. */
const GLOBAL_VALUE_FLAGS = new Set(["S", "L", "f", "c"]);
/** Global boolean flags, consumed before the verb. */
const GLOBAL_BOOL_FLAGS = new Set(["2", "8", "C", "l", "N", "q", "u", "v"]);

/**
 * Splits socket/global flags off the front. `-V` is a request, not a flag, so
 * it becomes the verb.
 */
export function parseGlobal(argv: string[]): ParsedCommand {
	let socketMode: SocketMode = null;
	let socketValue: string | null = null;
	let i = 0;

	while (i < argv.length) {
		const arg = argv[i] as string;
		if (arg === "-V" || arg === "--version") {
			return { socketMode, socketValue, verb: "-V", rest: argv.slice(i + 1) };
		}
		if (!arg.startsWith("-") || arg === "-") break;

		const letter = arg.slice(1, 2);
		if (GLOBAL_VALUE_FLAGS.has(letter)) {
			const inline = arg.slice(2);
			const value = inline !== "" ? inline : (argv[i + 1] ?? "");
			if (letter === "S" || letter === "L") {
				socketMode = letter;
				socketValue = value;
			}
			i += inline !== "" ? 1 : 2;
			continue;
		}
		if (GLOBAL_BOOL_FLAGS.has(letter)) {
			i += 1;
			continue;
		}
		// Unknown global flag: skip it rather than mis-parsing the verb
		// (fail-soft, per SPEC Feature 4).
		i += 1;
	}

	const verb = argv[i] ?? "";
	return { socketMode, socketValue, verb, rest: argv.slice(i + 1) };
}

export interface VerbFlags {
	/** Boolean flags present, by letter. */
	bools: Set<string>;
	/** Value flags, by letter. */
	values: Map<string, string>;
	/** Positional arguments before `--`. */
	positionals: string[];
	/**
	 * Everything after `--`, verbatim. tmux passes this as the command to run;
	 * `respawn-pane -- '<shell string>'` puts the whole teammate command here as
	 * a SINGLE argv element.
	 */
	command: string[];
	/** True when a literal `--` separator was present. */
	hasCommand: boolean;
}

/**
 * Per-verb value-flag tables. A letter absent here is treated as a boolean.
 * Only the verbs the shim implements need an entry; unknown verbs never reach
 * this function.
 */
export const VERB_VALUE_FLAGS: Record<string, string[]> = {
	"split-window": ["t", "l", "F", "c", "e", "p"],
	"new-session": ["t", "s", "n", "F", "c", "x", "y", "e"],
	"new-window": ["t", "n", "F", "c", "e"],
	"list-panes": ["t", "F", "f"],
	"list-windows": ["t", "F", "f"],
	"list-sessions": ["F", "f"],
	"display-message": ["t", "F", "c", "d"],
	"set-option": ["t"],
	"set-window-option": ["t"],
	"select-pane": ["t", "T", "P"],
	"kill-pane": ["t"],
	"kill-window": ["t"],
	"kill-session": ["t"],
	"respawn-pane": ["t", "c", "e"],
	"has-session": ["t"],
	"send-keys": ["t", "N"],
	"capture-pane": ["t", "S", "E", "b"],
	"select-layout": ["t"],
	"resize-pane": ["t", "x", "y"],
	"select-window": ["t"],
	show: ["t"],
	"show-options": ["t"],
	"show-environment": ["t"],
	"show-window-options": ["t"],
};

/**
 * Parses one verb's argv. `--` ends flag parsing; everything after it is the
 * command, kept verbatim.
 */
export function parseVerb(verb: string, argv: string[]): VerbFlags {
	const valueFlags = new Set(VERB_VALUE_FLAGS[verb] ?? ["t"]);
	const bools = new Set<string>();
	const values = new Map<string, string>();
	const positionals: string[] = [];
	let command: string[] = [];
	let hasCommand = false;

	let i = 0;
	while (i < argv.length) {
		const arg = argv[i] as string;
		if (arg === "--") {
			hasCommand = true;
			command = argv.slice(i + 1);
			break;
		}
		if (arg.length > 1 && arg.startsWith("-") && !/^-\d/.test(arg)) {
			const letter = arg.slice(1, 2);
			if (valueFlags.has(letter)) {
				const inline = arg.slice(2);
				if (inline !== "") {
					values.set(letter, inline);
					i += 1;
				} else {
					values.set(letter, argv[i + 1] ?? "");
					i += 2;
				}
				continue;
			}
			// Bundled booleans: -dP is -d -P.
			for (const ch of arg.slice(1)) bools.add(ch);
			i += 1;
			continue;
		}
		positionals.push(arg);
		i += 1;
	}

	return { bools, values, positionals, command, hasCommand };
}
