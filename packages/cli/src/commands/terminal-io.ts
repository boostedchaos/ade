import { numberOption } from "../args";
import { type Command, compact } from "../command";
import { usageError } from "../errors";
import { encodeKey, knownKeyNames, UnknownKeyError } from "../keys";

const PANE_ARG = {
	name: "pane",
	description: "Pane target: UUID, ref (pane:2), or `focused`",
	required: true,
} as const;

export const terminalIoCommands: Command[] = [
	{
		name: "send",
		group: "Terminal I/O",
		summary: "Type text into a terminal pane (no trailing newline)",
		kind: "request",
		positionals: [
			PANE_ARG,
			{ name: "text", description: "Text to type", rest: true },
		],
		options: [
			{
				name: "enter",
				type: "boolean",
				description: "Append Enter (carriage return) after the text",
			},
		],
		notes:
			"Text is sent verbatim and is NOT followed by Enter unless --enter is given.\n" +
			'Put `--` before text that starts with a dash: ade send focused -- "--help".',
		build: (input) => ({
			cmd: "send",
			args: compact({
				pane: input.positionals[0],
				text: input.positionals[1] ?? "",
				enter: input.options.enter === true ? true : undefined,
			}),
		}),
	},
	{
		name: "send-key",
		group: "Terminal I/O",
		summary: "Send a named key to a terminal pane",
		kind: "request",
		positionals: [
			PANE_ARG,
			{ name: "key", description: "Key name, e.g. Enter, C-c, M-x, Up" },
		],
		notes:
			"Key names follow tmux: Enter, Escape, Tab, Up/Down/Left/Right, Home, End,\n" +
			"PageUp/PageDown, Insert, Delete, BSpace, F1-F12, plus C- (control) and\n" +
			"M- (meta/alt) prefixes, e.g. C-c, C-M-a. A single printable character is\n" +
			"sent as itself. The CLI encodes the key to bytes; the server writes them.\n" +
			`Named keys: ${knownKeyNames().join(", ")}`,
		build: (input) => {
			const key = input.positionals[1] ?? "";
			try {
				return {
					cmd: "send-key",
					args: {
						pane: input.positionals[0],
						key,
						data: encodeKey(key),
					},
				};
			} catch (err) {
				if (err instanceof UnknownKeyError) throw usageError(err.message);
				throw err;
			}
		},
	},
	{
		name: "read-screen",
		group: "Terminal I/O",
		summary: "Read the visible screen of a terminal pane",
		kind: "request",
		positionals: [PANE_ARG],
		options: [
			{
				name: "lines",
				type: "string",
				placeholder: "<n>",
				description: "Return only the last N lines",
			},
		],
		build: (input) => ({
			cmd: "read-screen",
			args: compact({
				pane: input.positionals[0],
				lines: numberOption(input.options, "lines"),
			}),
		}),
	},
	{
		name: "capture-pane",
		group: "Terminal I/O",
		summary: "Capture a terminal pane's full scrollback",
		kind: "request",
		positionals: [PANE_ARG],
		options: [
			{
				name: "raw",
				type: "boolean",
				description: "Keep ANSI escape sequences instead of stripping them",
			},
		],
		build: (input) => ({
			cmd: "capture-pane",
			args: compact({
				pane: input.positionals[0],
				raw: input.options.raw === true ? true : undefined,
			}),
		}),
	},
];
