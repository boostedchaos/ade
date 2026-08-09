import type { OptionDef, PositionalDef } from "../args";
import { type Command, compact, targetFrom } from "../command";
import { formatListResult } from "../output";

export const PANE_TYPES = [
	"terminal",
	"browser",
	"file-viewer",
	"devtools",
] as const;
export const DIRECTIONS = ["left", "right", "up", "down"] as const;

const TARGET_POSITIONAL: PositionalDef = {
	name: "pane",
	description:
		"Pane target: UUID, ref (pane:2 / workspace:1), or `focused` (default)",
	required: false,
};

const focusOption: OptionDef = {
	name: "focus",
	type: "bool-value",
	choices: ["true", "false"],
	placeholder: "true|false",
	description:
		"Focus the new pane (default true). Use --focus false to keep focus.",
};

const cwdOption: OptionDef = {
	name: "cwd",
	type: "string",
	placeholder: "<dir>",
	description: "Working directory — terminal panes only",
};

const contentOptions: OptionDef[] = [
	{
		name: "type",
		type: "string",
		choices: PANE_TYPES,
		placeholder: PANE_TYPES.join("|"),
		description: "Pane type (default terminal)",
	},
	{
		name: "url",
		type: "string",
		placeholder: "<url>",
		description: "Initial URL — browser panes only",
	},
	{
		name: "path",
		type: "string",
		placeholder: "<file>",
		description: "File to open — file-viewer panes only",
	},
	cwdOption,
	{
		name: "command",
		type: "string",
		placeholder: "<cmd>",
		description: "Command to run — terminal panes only",
	},
	focusOption,
];

const directionOption = (required: boolean): OptionDef => ({
	name: "direction",
	type: "string",
	choices: DIRECTIONS,
	placeholder: DIRECTIONS.join("|"),
	required,
	description: "Where the new pane goes relative to the target pane",
});

const REF_NOTE =
	"Refs (pane:2, tab:1, workspace:1) are 1-based positions in the current UI\n" +
	"order at resolution time — they are NOT stable across layout changes.\n" +
	"They count within the FOCUSED context: tab:<n> within the focused\n" +
	"workspace, pane:<n> within the focused tab. Indices printed by\n" +
	"`list-tabs --workspace <other>` are NOT addressable as tab:<n> — use the\n" +
	"id from that listing instead.";

export const paneCommands: Command[] = [
	{
		name: "new-pane",
		group: "Panes / layout",
		summary: "Create a pane next to an existing one",
		kind: "request",
		positionals: [TARGET_POSITIONAL],
		options: [directionOption(true), ...contentOptions],
		notes: `${REF_NOTE}\n\nThe positional pane is the pane the new one is placed against\n(default: the focused pane).`,
		build: (input) => ({
			cmd: "new-pane",
			args: compact({
				pane: targetFrom(input),
				direction: input.options.direction,
				type: input.options.type ?? "terminal",
				url: input.options.url,
				path: input.options.path,
				cwd: input.options.cwd,
				command: input.options.command,
				focus: input.options.focus,
			}),
		}),
	},
	{
		name: "new-split",
		group: "Panes / layout",
		summary: "Split a pane, creating a new pane in the freed space",
		kind: "request",
		positionals: [TARGET_POSITIONAL],
		options: [directionOption(true), cwdOption, focusOption],
		notes: REF_NOTE,
		build: (input) => ({
			cmd: "new-split",
			args: compact({
				pane: targetFrom(input),
				direction: input.options.direction,
				cwd: input.options.cwd,
				focus: input.options.focus,
			}),
		}),
	},
	{
		name: "split-off",
		group: "Panes / layout",
		summary: "Move a pane out of its split into a tab of its own",
		kind: "request",
		positionals: [TARGET_POSITIONAL],
		notes: REF_NOTE,
		build: (input) => ({
			cmd: "split-off",
			args: { pane: targetFrom(input) },
		}),
	},
	{
		name: "focus-pane",
		group: "Panes / layout",
		summary: "Focus a pane",
		kind: "request",
		positionals: [{ ...TARGET_POSITIONAL, required: true }],
		notes: REF_NOTE,
		build: (input) => ({
			cmd: "focus-pane",
			args: { pane: targetFrom(input) },
		}),
	},
	{
		name: "move-pane",
		group: "Panes / layout",
		summary: "Move a pane into another tab",
		kind: "request",
		positionals: [TARGET_POSITIONAL],
		options: [
			{
				name: "to-tab",
				type: "string",
				required: true,
				placeholder: "<tab>",
				description: "Destination tab: UUID, ref (tab:2), or `focused`",
			},
		],
		notes: REF_NOTE,
		build: (input) => ({
			cmd: "move-pane",
			args: compact({
				pane: targetFrom(input),
				"to-tab": input.options["to-tab"],
			}),
		}),
	},
	{
		name: "close-pane",
		group: "Panes / layout",
		summary: "Close a pane",
		kind: "request",
		positionals: [TARGET_POSITIONAL],
		notes: REF_NOTE,
		build: (input) => ({
			cmd: "close-pane",
			args: { pane: targetFrom(input) },
		}),
	},
	{
		name: "list-panes",
		group: "Panes / layout",
		summary: "List panes",
		kind: "request",
		options: [
			{
				name: "tab",
				type: "string",
				placeholder: "<tab>",
				description: "Only panes in this tab",
			},
		],
		build: (input) => ({
			cmd: "list-panes",
			args: compact({ tab: input.options.tab }),
		}),
		format: (result) =>
			formatListResult(result, "panes", { label: "Tab", key: "tabId" }),
	},
];
