import type { Command } from "../command";
import { eventCommands } from "./events";
import { notificationCommands } from "./notifications";
import { paneCommands } from "./panes";
import { sessionCommands } from "./sessions";
import { stubCommands } from "./stubs";
import { terminalIoCommands } from "./terminal-io";
import { workspaceCommands } from "./workspaces";

export const COMMANDS: Command[] = [
	...paneCommands,
	...workspaceCommands,
	...terminalIoCommands,
	...sessionCommands,
	...notificationCommands,
	...eventCommands,
	...stubCommands,
];

export const GROUP_ORDER = [
	"Panes / layout",
	"Tabs / workspaces",
	"Terminal I/O",
	"Agent sessions",
	"Notifications",
	"Events",
	"Not yet implemented",
];

export function findCommand(name: string): Command | undefined {
	return COMMANDS.find((command) => command.name === name);
}
