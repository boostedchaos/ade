import type { Command } from "../command";
import { eventCommands } from "./events";
import { paneCommands } from "./panes";
import { stubCommands } from "./stubs";
import { terminalIoCommands } from "./terminal-io";
import { workspaceCommands } from "./workspaces";

export const COMMANDS: Command[] = [
	...paneCommands,
	...workspaceCommands,
	...terminalIoCommands,
	...eventCommands,
	...stubCommands,
];

export const GROUP_ORDER = [
	"Panes / layout",
	"Tabs / workspaces",
	"Terminal I/O",
	"Events",
	"Not yet implemented",
];

export function findCommand(name: string): Command | undefined {
	return COMMANDS.find((command) => command.name === name);
}
