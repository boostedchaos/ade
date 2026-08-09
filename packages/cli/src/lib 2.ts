/**
 * Library surface of @ade/cli, for tests and for other packages that need the
 * wire client without running the bin. Importing `src/index.ts` executes the
 * CLI, so nothing should import that.
 */
export { parseCommandArgs } from "./args";
export type { ClientOptions, ControlEvent, ControlResponse } from "./client";
export { ControlClient, NdjsonParser } from "./client";
export { COMMANDS, findCommand } from "./commands";
export { CliError, EXIT } from "./errors";
export { encodeKey, knownKeyNames, UnknownKeyError } from "./keys";
export type { RunIo } from "./run";
export { run } from "./run";
export {
	getAdeDirName,
	getControlSocketPathFor,
	getControlTokenPathFor,
} from "./socket-path";
