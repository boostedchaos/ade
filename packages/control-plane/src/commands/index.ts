import type { CommandRegistry } from "../server";
import { browserCommands } from "./browser";
import { notificationCommands } from "./notifications";
import { paneCommands } from "./panes";
import { sessionCommands } from "./sessions";
import { statusCommands } from "./status";
import { terminalCommands } from "./terminal";
import { todoCommands } from "./todos";
import { workspaceCommands } from "./workspaces";

/**
 * Phase 1–5 command surface. `hello` and `subscribe` are handled by the server
 * itself (they change connection state) and deliberately are NOT registry
 * entries — a registry entry is by definition a post-auth command.
 */
export const phase1Commands: CommandRegistry = {
	...paneCommands,
	...workspaceCommands,
	...terminalCommands,
	...sessionCommands,
	...notificationCommands,
	...todoCommands,
	...browserCommands,
	...statusCommands,
};

export {
	browserCommands,
	notificationCommands,
	paneCommands,
	sessionCommands,
	statusCommands,
	terminalCommands,
	todoCommands,
	workspaceCommands,
};
