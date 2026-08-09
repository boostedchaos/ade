/**
 * Human-readable rendering of server results.
 *
 * The server lane owns the exact result shapes, so formatting is deliberately
 * shape-tolerant: arrays of objects become aligned tables, objects become
 * key/value lines, and a text-bearing result prints its text verbatim. A shape
 * the CLI does not recognise falls back to pretty JSON rather than an error —
 * `--json` is always available for machine consumers.
 */

type Row = Record<string, unknown>;

const isRecord = (value: unknown): value is Row =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function scalar(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return JSON.stringify(value);
}

function table(rows: Row[]): string {
	const columns: string[] = [];
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!columns.includes(key)) columns.push(key);
		}
	}
	if (columns.length === 0) return "";

	const header = columns.map((c) => c.toUpperCase());
	const body = rows.map((row) => columns.map((c) => scalar(row[c])));
	const widths = header.map((h, i) =>
		Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)),
	);
	const line = (cells: string[]) =>
		cells
			.map((cell, i) =>
				cell.padEnd(i === cells.length - 1 ? 0 : (widths[i] ?? 0)),
			)
			.join("  ")
			.trimEnd();

	return [line(header), ...body.map(line)].join("\n");
}

/** Result fields that carry terminal text and must be printed verbatim. */
const TEXT_FIELDS = ["text", "content", "screen", "output", "data"];

export function formatResult(result: unknown): string {
	if (result === undefined || result === null) return "";
	if (typeof result === "string") return result;
	if (typeof result === "number" || typeof result === "boolean") {
		return String(result);
	}

	if (Array.isArray(result)) {
		if (result.length === 0) return "(none)";
		if (result.every(isRecord)) return table(result as Row[]);
		return result.map(scalar).join("\n");
	}

	if (isRecord(result)) {
		for (const field of TEXT_FIELDS) {
			const value = result[field];
			if (typeof value === "string") return value;
		}
		// A single-key wrapper around a list ({panes: [...]}) is the common shape.
		const keys = Object.keys(result);
		const only = keys[0];
		if (
			keys.length === 1 &&
			only !== undefined &&
			Array.isArray(result[only])
		) {
			return formatResult(result[only]);
		}
		return keys.map((key) => `${key}: ${scalar(result[key])}`).join("\n");
	}

	return JSON.stringify(result, null, 2);
}
