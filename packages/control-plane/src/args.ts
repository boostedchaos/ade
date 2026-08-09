import { ControlError } from "./protocol";

/**
 * Argument coercion. Deliberately hand-rolled rather than zod-per-command:
 * every failure must map to BAD_REQUEST with a message naming the field, and
 * these are the only five shapes Phase 1 needs.
 */

export function requireString(
	args: Record<string, unknown>,
	name: string,
): string {
	const value = args[name];
	if (typeof value !== "string" || value.length === 0) {
		throw new ControlError(
			"BAD_REQUEST",
			`"${name}" must be a non-empty string`,
		);
	}
	return value;
}

export function optionalString(
	args: Record<string, unknown>,
	name: string,
): string | undefined {
	const value = args[name];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new ControlError("BAD_REQUEST", `"${name}" must be a string`);
	}
	return value;
}

export function optionalBoolean(
	args: Record<string, unknown>,
	name: string,
	fallback: boolean,
): boolean {
	const value = args[name];
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	// The CLI passes `--focus false` as a string; accept both spellings rather
	// than making every caller remember which layer parsed it.
	if (value === "true") return true;
	if (value === "false") return false;
	throw new ControlError("BAD_REQUEST", `"${name}" must be a boolean`);
}

export function optionalPositiveInt(
	args: Record<string, unknown>,
	name: string,
): number | undefined {
	const value = args[name];
	if (value === undefined || value === null) return undefined;
	const n =
		typeof value === "number" ? value : Number.parseInt(String(value), 10);
	if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
		throw new ControlError(
			"BAD_REQUEST",
			`"${name}" must be a positive integer`,
		);
	}
	return n;
}

export function requireEnum<T extends string>(
	args: Record<string, unknown>,
	name: string,
	allowed: readonly T[],
	fallback?: T,
): T {
	const value = args[name];
	if ((value === undefined || value === null) && fallback !== undefined) {
		return fallback;
	}
	if (
		typeof value === "string" &&
		(allowed as readonly string[]).includes(value)
	) {
		return value as T;
	}
	throw new ControlError(
		"BAD_REQUEST",
		`"${name}" must be one of: ${allowed.join(", ")}`,
	);
}
