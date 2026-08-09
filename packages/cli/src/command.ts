/**
 * Command descriptor. One shape for every verb so that dispatch, --help and
 * validation are all derived from the same declaration.
 */
import type { OptionDef, ParsedInput, PositionalDef } from "./args";

export type CommandKind = "request" | "stream" | "stub";

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
