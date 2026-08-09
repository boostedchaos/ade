/**
 * Explicit status reporting (Mission Control Feature 1, Status group).
 *
 * For agents that have no hooks — anything that is not Claude Code — so they
 * can report their own state. Server-side these land in the same ingest path
 * the Claude hooks use, so a declared `needsInput` lights the pane ring, the
 * badges and jump-to-unread with no extra plumbing.
 *
 * The server REQUIRES `--pane` (a status is a claim about a specific pane, and
 * defaulting to the focused one would let a background agent flip another
 * agent's state). The CLI fills it from $ADE_SURFACE_ID, which ADE injects into
 * every PTY, so an agent running inside a pane still types nothing.
 */
import type { ParsedInput } from "../args";
import type { Command } from "../command";
import { usageError } from "../errors";

const SURFACE_ID_VAR = "ADE_SURFACE_ID";

const STATES = ["working", "needsInput", "idle"] as const;

const PANE_OPTION = {
	name: "pane",
	type: "string",
	placeholder: "<pane>",
	description: `Pane to report for: id, pane:<n>, or \`focused\`. Defaults to $${SURFACE_ID_VAR}.`,
} as const;

/** Explicit --pane wins; otherwise the pane ADE injected into this process. */
function resolvePane(input: ParsedInput, verb: string): string {
	const pane =
		(input.options.pane as string | undefined) || process.env[SURFACE_ID_VAR];
	if (!pane) {
		throw usageError(
			`ade ${verb}: no pane to report for — pass --pane, or run inside an ADE ` +
				`pane where $${SURFACE_ID_VAR} is set`,
		);
	}
	return pane;
}

/**
 * "clear" is spelled literally rather than being an absent argument, so a shell
 * variable that expands to nothing fails loudly instead of silently wiping a
 * progress bar. Validated here as well as server-side so a bad value is a usage
 * error (exit 2), not a command failure (exit 1).
 */
export function parseProgressArg(raw: string | undefined): number | "clear" {
	if (raw === undefined || raw === "") {
		throw usageError(
			'ade set-progress: a value is required — 0-100, or "clear" to remove the bar',
		);
	}
	if (raw === "clear") return "clear";
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0 || value > 100) {
		throw usageError(
			`ade set-progress: value must be an integer 0-100, or "clear" (got "${raw}")`,
		);
	}
	return value;
}

export const statusCommands: Command[] = [
	{
		name: "set-status",
		group: "Status",
		summary: "Report a pane's agent status (working | needsInput | idle)",
		kind: "request",
		positionals: [
			{ name: "state", description: STATES.join(" | "), required: true },
		],
		options: [PANE_OPTION],
		notes:
			"For agents without hooks. `needsInput` raises the same attention ring,\n" +
			"badges and notification a Claude permission prompt does, so use it when\n" +
			"you are actually blocked on the human.\n\n" +
			`Only terminal panes host agents; targeting any other pane type fails.`,
		build: (input) => {
			const state = input.positionals[0];
			if (
				state === undefined ||
				!(STATES as readonly string[]).includes(state)
			) {
				throw usageError(
					`ade set-status: state must be one of ${STATES.join(" | ")} (got "${state ?? ""}")`,
				);
			}
			return {
				cmd: "set-status",
				args: { pane: resolvePane(input, "set-status"), state },
			};
		},
		format: (result) => {
			const row = (result ?? {}) as Record<string, unknown>;
			if (row.applied === false) {
				return `${String(row.paneId ?? "?")}: already ${String(row.to ?? "that state")}, no change`;
			}
			return `${String(row.paneId ?? "?")}: ${String(row.from ?? "unknown")} -> ${String(row.to ?? "?")}`;
		},
	},

	{
		name: "set-progress",
		group: "Status",
		summary: "Set a pane's progress bar (0-100, or clear)",
		kind: "request",
		positionals: [
			{
				name: "value",
				description: '0-100, or the literal word "clear"',
				required: true,
			},
		],
		options: [PANE_OPTION],
		notes:
			"Progress annotates an EXISTING agent session — it cannot create one, so a\n" +
			"pane with no session reports NOT_FOUND. `clear` removes the bar; note\n" +
			"that 0 is a real value meaning 0%, not the same as clearing it.",
		build: (input) => ({
			cmd: "set-progress",
			args: {
				pane: resolvePane(input, "set-progress"),
				value: parseProgressArg(input.positionals[0]),
			},
		}),
		format: (result) => {
			const row = (result ?? {}) as Record<string, unknown>;
			const progress = row.progress;
			return progress === null || progress === undefined
				? `${String(row.paneId ?? "?")}: progress cleared`
				: `${String(row.paneId ?? "?")}: ${String(progress)}%`;
		},
	},
];
