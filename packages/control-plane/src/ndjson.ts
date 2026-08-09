/**
 * NDJSON line framing: exactly one JSON object per \n-terminated line.
 *
 * Same idiom as the terminal-host daemon's per-socket parser — a string
 * buffer split on \n, blank lines skipped, one JSON.parse per line — so a
 * chunk that splits a line mid-object and a chunk carrying several pipelined
 * lines both behave.
 */
export interface NdjsonParseResult<T> {
	/** Successfully parsed objects, in arrival order. */
	values: T[];
	/** Raw lines that failed to parse, in arrival order. Already truncated. */
	invalid: string[];
}

export class NdjsonParser<T = unknown> {
	private buffer = "";

	constructor(
		/**
		 * Hard cap on a single unterminated line. A client that never sends a
		 * newline must not be able to grow main's heap without bound.
		 */
		private readonly maxLineBytes = 1024 * 1024,
	) {}

	/** True once a line has exceeded maxLineBytes; the caller should close. */
	overflowed = false;

	parse(chunk: string): NdjsonParseResult<T> {
		const values: T[] = [];
		const invalid: string[] = [];

		this.buffer += chunk;

		if (this.buffer.length > this.maxLineBytes) {
			// Only an overflow if no newline arrived to drain it.
			if (!this.buffer.includes("\n")) {
				this.overflowed = true;
				this.buffer = "";
				return { values, invalid };
			}
		}

		const lines = this.buffer.split("\n");
		// The trailing element is either "" (chunk ended on \n) or a partial line.
		this.buffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				values.push(JSON.parse(trimmed) as T);
			} catch {
				invalid.push(trimmed);
			}
		}

		return { values, invalid };
	}
}

export function encodeNdjson(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}
