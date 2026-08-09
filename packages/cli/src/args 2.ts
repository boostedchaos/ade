/**
 * Argument parsing built on node:util parseArgs — no runtime dependency.
 *
 * Every command declares its options and positionals declaratively so that
 * --help text and validation come from one source.
 */
import { parseArgs as nodeParseArgs } from "node:util";
import { usageError } from "./errors";

export type OptionType = "string" | "boolean" | "bool-value";

export interface OptionDef {
	name: string;
	type: OptionType;
	short?: string;
	description: string;
	required?: boolean;
	choices?: readonly string[];
	/** Shown in help as --name <placeholder>. */
	placeholder?: string;
	default?: string | boolean;
}

export interface PositionalDef {
	name: string;
	description: string;
	required?: boolean;
	/** Consumes the remaining argv, joined with spaces. */
	rest?: boolean;
}

export interface ParsedInput {
	options: Record<string, string | boolean | undefined>;
	positionals: string[];
	json: boolean;
	help: boolean;
}

export const GLOBAL_OPTIONS: OptionDef[] = [
	{
		name: "json",
		type: "boolean",
		description: "Print the raw JSON result instead of human-readable text",
	},
	{ name: "help", type: "boolean", short: "h", description: "Show this help" },
];

function coerceBoolValue(name: string, raw: string): boolean {
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw usageError(`--${name} expects true or false, got "${raw}"`);
}

export function parseCommandArgs(
	argv: string[],
	options: OptionDef[],
	positionals: PositionalDef[] = [],
): ParsedInput {
	const defs = [...options, ...GLOBAL_OPTIONS];
	const config: Record<
		string,
		{ type: "string" | "boolean"; short?: string; multiple?: boolean }
	> = {};
	for (const def of defs) {
		config[def.name] = {
			type: def.type === "boolean" ? "boolean" : "string",
			...(def.short ? { short: def.short } : {}),
		};
	}

	let parsed: {
		values: Record<string, string | boolean | undefined>;
		positionals: string[];
	};
	try {
		parsed = nodeParseArgs({
			args: argv,
			options: config,
			allowPositionals: true,
			strict: true,
		}) as typeof parsed;
	} catch (err) {
		throw usageError(err instanceof Error ? err.message : String(err));
	}

	const help = parsed.values.help === true;
	const json = parsed.values.json === true;
	const values: Record<string, string | boolean | undefined> = {};

	for (const def of defs) {
		if (def.name === "help" || def.name === "json") continue;
		let value = parsed.values[def.name];
		if (value === undefined && def.default !== undefined) value = def.default;
		if (value === undefined) {
			if (def.required && !help) {
				throw usageError(`Missing required option --${def.name}`);
			}
			continue;
		}
		if (def.type === "bool-value" && typeof value === "string") {
			values[def.name] = coerceBoolValue(def.name, value);
			continue;
		}
		if (
			def.choices &&
			typeof value === "string" &&
			!def.choices.includes(value)
		) {
			throw usageError(
				`--${def.name} must be one of: ${def.choices.join(", ")} (got "${value}")`,
			);
		}
		values[def.name] = value;
	}

	const rest = positionals.find((p) => p.rest);
	const fixed = rest ? positionals.length - 1 : positionals.length;
	const collected: string[] = [];
	if (!help) {
		for (let i = 0; i < fixed; i++) {
			const def = positionals[i];
			const value = parsed.positionals[i];
			if (value === undefined) {
				if (def?.required !== false) {
					throw usageError(`Missing required argument <${def?.name}>`);
				}
				continue;
			}
			collected.push(value);
		}
		if (rest) {
			const tail = parsed.positionals.slice(fixed);
			if (tail.length === 0 && rest.required !== false) {
				throw usageError(`Missing required argument <${rest.name}>`);
			}
			if (tail.length > 0) collected.push(tail.join(" "));
		} else if (parsed.positionals.length > fixed) {
			throw usageError(
				`Unexpected argument "${parsed.positionals[fixed]}" (expected ${fixed})`,
			);
		}
	}

	return { options: values, positionals: collected, json, help };
}

/** Reads a numeric option, rejecting non-numbers with a usage error. */
export function numberOption(
	values: Record<string, string | boolean | undefined>,
	name: string,
): number | undefined {
	const raw = values[name];
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		throw usageError(`--${name} expects a number, got "${String(raw)}"`);
	}
	return parsed;
}
