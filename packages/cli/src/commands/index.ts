import type { Command } from "../command";
import { browserCommands } from "./browser";
import { eventCommands } from "./events";
import { notificationCommands } from "./notifications";
import { paneCommands } from "./panes";
import { sessionCommands } from "./sessions";
import { statusCommands } from "./status";
import { stubCommands } from "./stubs";
import { teamsCommands } from "./teams";
import { terminalIoCommands } from "./terminal-io";
import { tmuxCompatCommands } from "./tmux-compat";
import { todoCommands } from "./todos";
import { workspaceCommands } from "./workspaces";

export const COMMANDS: Command[] = [
	...paneCommands,
	...workspaceCommands,
	...terminalIoCommands,
	...sessionCommands,
	...statusCommands,
	...todoCommands,
	...browserCommands,
	...notificationCommands,
	...eventCommands,
	...teamsCommands,
	...tmuxCompatCommands,
	...stubCommands,
];

export const GROUP_ORDER = [
	"Panes / layout",
	"Tabs / workspaces",
	"Terminal I/O",
	"Agent sessions",
	"Status",
	"Todos",
	"Browser panes",
	"Notifications",
	"Events",
	"Teams",
	"Not yet implemented",
];

export function findCommand(name: string): Command | undefined {
	return COMMANDS.find((command) => command.name === name);
}
