import type { CommandRegistry } from "../server";
import { paneCommands } from "./panes";
import { terminalCommands } from "./terminal";
import { workspaceCommands } from "./workspaces";

/**
 * Phase 1 command surface. `hello` and `subscribe` are handled by the server
 * itself (they change connection state) and deliberately are NOT registry
 * entries — a registry entry is by definition a post-auth command.
 */
export const phase1Commands: CommandRegistry = {
	...paneCommands,
	...workspaceCommands,
	...terminalCommands,
};

export { paneCommands, terminalCommands, workspaceCommands };
