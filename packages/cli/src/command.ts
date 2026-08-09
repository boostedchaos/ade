/**
 * Command descriptor. One shape for every verb so that dispatch, --help and
 * validation are all derived from the same declaration.
 */
import type { OptionDef, ParsedInput, PositionalDef } from "./args";

/**
 * `silent` is `request` with every failure swallowed and exit 0 — the shape a
 * command called from an agent's hook must have, so that a closed app or a
 * terminal outside ADE never breaks the agent. Only `agent-event` uses it.
 */
export type CommandKind = "request" | "stream" | "stub" | "silent";

export interface WireRequest {
	cmd: string;
	args: Record<string, unknown>;
}

export interface Command {
	name: string;
	/** Heading this command appears under in `ade --help`. */
	group: string;
	summary: string;
	kind: CommandKind;
	options?: OptionDef[];
	positionals?: PositionalDef[];
	/** Extra prose appended to `ade <cmd> --help`. */
	notes?: string;
	/** Stubs and pass-through groups take arbitrary argv. */
	rawArgs?: boolean;
	/** request/stream: translate parsed input into the wire request. */
	build?: (input: ParsedInput) => WireRequest;
	/** request: render the server result for humans. Defaults to formatResult. */
	format?: (result: unknown, input: ParsedInput) => string;
	/**
	 * request: what to print when the app is not running, instead of exiting 3.
	 * For commands whose answer is partly on disk — `hooks status` can still
	 * report the hooks file's coverage with ADE closed, and "socket unreachable"
	 * is the most useful half of what it was asked. Returning null declines the
	 * fallback, leaving the normal exit-3 behaviour in place.
	 */
	offlineFallback?: (input: ParsedInput) => string | null;
}

/** Drops undefined values so the wire request stays minimal. */
export function compact(
	args: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** Targets default to the focused entity (PROTOCOL.md "Target resolution"). */
export const FOCUSED = "focused";

export function targetFrom(input: ParsedInput, index = 0): string {
	return input.positionals[index] ?? FOCUSED;
}
