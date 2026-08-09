import { type Command, compact, targetFrom } from "../command";

export const workspaceCommands: Command[] = [
	{
		name: "new-tab",
		group: "Tabs / workspaces",
		summary: "Create a tab",
		kind: "request",
		options: [
			{
				name: "workspace",
				type: "string",
				placeholder: "<workspace>",
				description: "Workspace to create the tab in (default: focused)",
			},
			{
				name: "cwd",
				type: "string",
				placeholder: "<dir>",
				description: "Working directory for the tab's first terminal",
			},
			{
				name: "command",
				type: "string",
				placeholder: "<cmd>",
				description: "Command to run in the tab's first terminal",
			},
			{
				name: "focus",
				type: "bool-value",
				choices: ["true", "false"],
				placeholder: "true|false",
				description: "Focus the new tab (default true)",
			},
		],
		build: (input) => ({
			cmd: "new-tab",
			args: compact({
				workspace: input.options.workspace,
				cwd: input.options.cwd,
				command: input.options.command,
				focus: input.options.focus,
			}),
		}),
	},
	{
		name: "list-tabs",
		group: "Tabs / workspaces",
		summary: "List tabs",
		kind: "request",
		options: [
			{
				name: "workspace",
				type: "string",
				placeholder: "<workspace>",
				description: "Only tabs in this workspace",
			},
		],
		build: (input) => ({
			cmd: "list-tabs",
			args: compact({ workspace: input.options.workspace }),
		}),
	},
	{
		name: "new-workspace",
		group: "Tabs / workspaces",
		summary: "Create a workspace for a project",
		kind: "request",
		options: [
			{
				name: "project",
				type: "string",
				required: true,
				placeholder: "<project>",
				description: "Project name or path the workspace opens",
			},
			{
				name: "worktree",
				type: "boolean",
				description: "Create the workspace in its own git worktree",
			},
		],
		build: (input) => ({
			cmd: "new-workspace",
			args: compact({
				project: input.options.project,
				worktree: input.options.worktree,
			}),
		}),
	},
	{
		name: "list-workspaces",
		group: "Tabs / workspaces",
		summary: "List workspaces",
		kind: "request",
		build: () => ({ cmd: "list-workspaces", args: {} }),
	},
	{
		name: "focus-workspace",
		group: "Tabs / workspaces",
		summary: "Focus a workspace",
		kind: "request",
		positionals: [
			{
				name: "workspace",
				description: "Workspace target: UUID, ref (workspace:2), or `focused`",
				required: true,
			},
		],
		build: (input) => ({
			cmd: "focus-workspace",
			args: { workspace: targetFrom(input) },
		}),
	},
];
