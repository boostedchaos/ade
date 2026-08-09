/**
 * Reader for docs/specs/mission-control/probe/tmux-calls.log.
 *
 * The log is the captured contract, so the golden tests drive themselves from
 * it rather than from a hand-copied list of argvs — a hand-copied list would
 * keep passing after the contract was re-captured against a newer Claude Code.
 *
 * Records look like:
 *   === 1786277378.548231 pid=81429
 *   ARGV: ['display-message', '-p', '-t', '%0', '#{session_name}…']
 *   CWD: /some/dir
 */
import { readFileSync } from "node:fs";

export interface ProbeCall {
	run: string;
	timestamp: number;
	pid: number;
	argv: string[];
	cwd: string;
}

/**
 * Parses one python-repr list of strings. Python's repr uses single quotes and
 * escapes `\` and `'`; it switches to double quotes only when the string
 * contains a single quote but no double quote, so both forms are handled.
 */
export function parsePythonList(text: string): string[] {
	const body = text.trim();
	if (!body.startsWith("[") || !body.endsWith("]")) {
		throw new Error(`not a python list: ${text}`);
	}
	const out: string[] = [];
	let i = 1;
	const end = body.length - 1;
	while (i < end) {
		const ch = body[i];
		if (ch === " " || ch === ",") {
			i += 1;
			continue;
		}
		if (ch !== "'" && ch !== '"') {
			throw new Error(`unexpected character at ${i} in: ${text}`);
		}
		const quote = ch;
		i += 1;
		let value = "";
		while (i < end && body[i] !== quote) {
			if (body[i] === "\\") {
				const next = body[i + 1];
				value +=
					next === "n"
						? "\n"
						: next === "t"
							? "\t"
							: next === "r"
								? "\r"
								: (next ?? "");
				i += 2;
				continue;
			}
			value += body[i];
			i += 1;
		}
		i += 1;
		out.push(value);
	}
	return out;
}

export function parseProbeLog(path: string): ProbeCall[] {
	const lines = readFileSync(path, "utf8").split("\n");
	const calls: ProbeCall[] = [];
	let run = "unknown";
	let pending: { timestamp: number; pid: number } | null = null;
	let argv: string[] | null = null;

	for (const line of lines) {
		const runMatch = /^##\s+(RUN [A-Z].*)$/.exec(line);
		if (runMatch?.[1]) {
			run = runMatch[1].trim();
			continue;
		}
		const header = /^=== ([\d.]+) pid=(\d+)/.exec(line);
		if (header) {
			pending = { timestamp: Number(header[1]), pid: Number(header[2]) };
			argv = null;
			continue;
		}
		if (line.startsWith("ARGV: ")) {
			argv = parsePythonList(line.slice("ARGV: ".length));
			continue;
		}
		if (line.startsWith("CWD: ") && pending && argv) {
			calls.push({
				run,
				timestamp: pending.timestamp,
				pid: pending.pid,
				argv,
				cwd: line.slice("CWD: ".length).trim(),
			});
			pending = null;
			argv = null;
		}
	}
	return calls;
}
