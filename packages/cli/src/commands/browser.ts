/**
 * Browser-pane scripting (Mission Control Feature 1, Browser group).
 *
 * `ade browser <verb>` maps 1:1 onto the server's `browser-<verb>` commands.
 * Every verb except `open` and `capabilities` names exactly one pane and the
 * server proves it is a browser pane before running anything — there is no
 * "all panes" form, by design, because these verbs execute JavaScript inside a
 * page holding the user's session cookies.
 *
 * `--pane` is required rather than defaulting to `focused` for the same
 * reason: injecting script into whatever the human happens to be looking at is
 * not something a caller should be able to do by omission.
 */
import { type Command, compact } from "../command";
import { usageError } from "../errors";

const VERBS = [
	"open",
	"navigate",
	"click",
	"type",
	"fill",
	"screenshot",
	"info",
	"capabilities",
] as const;
type Verb = (typeof VERBS)[number];

/** Verbs that act on an existing browser pane, so `--pane` must be given. */
const PANE_REQUIRED: readonly Verb[] = [
	"navigate",
	"click",
	"type",
	"fill",
	"screenshot",
	"info",
];

const DIRECTIONS = ["left", "right", "up", "down"] as const;

/**
 * Kept in step with the server's BROWSER_UNSUPPORTED. Printed in --help so the
 * answer to "does this do CDP?" is in the tool, not in a failure message;
 * `ade browser capabilities` returns the machine-readable copy.
 */
const UNSUPPORTED = [
	"no Chrome DevTools Protocol attachment",
	"no cookie or profile import/export",
	"no multi-pane fan-out — every verb acts on exactly one named pane",
];

function parseVerb(value: string | undefined): Verb {
	if (value !== undefined && (VERBS as readonly string[]).includes(value)) {
		return value as Verb;
	}
	throw usageError(
		`ade browser: expected one of ${VERBS.join(" | ")}, got "${value ?? ""}"`,
	);
}

/**
 * Parse `--fields` into the object the server expects.
 *
 * Non-string values are rejected here as well as server-side so a typo is a
 * usage error (exit 2) rather than a command failure (exit 1). Coercing
 * `{"#qty": 3}` would work today and do the wrong thing the first time someone
 * passes `null` meaning "clear this field".
 */
export function parseFieldsArg(raw: string): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw usageError(
			`--fields must be a JSON object: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw usageError('--fields must be a JSON object of {"selector": "text"}');
	}
	const entries = Object.entries(parsed as Record<string, unknown>);
	if (entries.length === 0) throw usageError("--fields must not be empty");
	for (const [selector, text] of entries) {
		if (typeof text !== "string") {
			throw usageError(`--fields."${selector}" must be a string`);
		}
	}
	return Object.fromEntries(entries) as Record<string, string>;
}

function requirePane(
	input: { options: Record<string, unknown> },
	verb: Verb,
): string {
	const pane = input.options.pane as string | undefined;
	if (!pane) {
		throw usageError(`ade browser ${verb}: --pane is required`);
	}
	return pane;
}

function requireOption(
	input: { options: Record<string, unknown> },
	name: string,
	verb: Verb,
): string {
	const value = input.options[name] as string | undefined;
	if (value === undefined) {
		throw usageError(`ade browser ${verb}: --${name} is required`);
	}
	return value;
}

export const browserCommands: Command[] = [
	{
		name: "browser",
		group: "Browser panes",
		summary: "Drive a browser pane (open | navigate | click | type | fill | …)",
		kind: "request",
		positionals: [
			{ name: "verb", description: VERBS.join(" | "), required: true },
		],
		options: [
			{
				name: "pane",
				type: "string",
				placeholder: "<pane>",
				description:
					"Browser pane to act on: id, pane:<n>, or `focused`. Required for " +
					PANE_REQUIRED.join(", "),
			},
			{
				name: "url",
				type: "string",
				placeholder: "<url>",
				description: "URL — required for `open` and `navigate`",
			},
			{
				name: "selector",
				type: "string",
				placeholder: "<css>",
				description: "CSS selector — required for `click` and `type`",
			},
			{
				name: "text",
				type: "string",
				placeholder: "<text>",
				description:
					"Text for `type`. An empty string is valid and clears the field.",
			},
			{
				name: "fields",
				type: "string",
				placeholder: "<json>",
				description: '`fill` only: JSON object of {"selector": "text"}',
			},
			{
				name: "path",
				type: "string",
				placeholder: "<file>",
				description: "`screenshot` only: where to write the PNG (optional)",
			},
			{
				name: "direction",
				type: "string",
				choices: DIRECTIONS,
				placeholder: DIRECTIONS.join("|"),
				description: "`open` only: split direction (default right)",
			},
			{
				name: "focus",
				type: "bool-value",
				choices: ["true", "false"],
				placeholder: "true|false",
				description: "`open` only: focus the new pane (default true)",
			},
		],
		notes:
			"Examples:\n" +
			"  ade browser open --url https://example.com --direction right --focus false\n" +
			'  ade browser type --pane pane:2 --selector "#email" --text me@example.com\n' +
			'  ade browser fill --pane pane:2 --fields \'{"#user":"kyle","#pw":"hunter2"}\'\n' +
			"  ade browser screenshot --pane pane:2 --path /tmp/shot.png\n\n" +
			`NOT SUPPORTED:\n${UNSUPPORTED.map((line) => `  - ${line}`).join("\n")}\n\n` +
			"`fill` applies fields in order and STOPS at the first failure, reporting\n" +
			"how many were filled — it never leaves a half-filled form looking like a\n" +
			"success. `screenshot` returns the file path written, not image bytes.",
		build: (input) => {
			const verb = parseVerb(input.positionals[0]);
			const cmd = `browser-${verb}`;

			if (verb === "capabilities") return { cmd, args: {} };

			if (verb === "open") {
				return {
					cmd,
					args: compact({
						url: requireOption(input, "url", verb),
						// Optional: the source pane the new one splits off, default focused.
						pane: input.options.pane,
						direction: input.options.direction,
						focus: input.options.focus,
					}),
				};
			}

			const pane = requirePane(input, verb);

			if (verb === "navigate") {
				return { cmd, args: { pane, url: requireOption(input, "url", verb) } };
			}
			if (verb === "click") {
				return {
					cmd,
					args: { pane, selector: requireOption(input, "selector", verb) },
				};
			}
			if (verb === "type") {
				// requireOption, not a truthiness check: `--text ""` is a legitimate
				// "clear this field" and must reach the server as an empty string.
				return {
					cmd,
					args: {
						pane,
						selector: requireOption(input, "selector", verb),
						text: requireOption(input, "text", verb),
					},
				};
			}
			if (verb === "fill") {
				return {
					cmd,
					args: {
						pane,
						fields: parseFieldsArg(requireOption(input, "fields", verb)),
					},
				};
			}
			if (verb === "screenshot") {
				return { cmd, args: compact({ pane, path: input.options.path }) };
			}
			return { cmd, args: { pane } };
		},
		format: (result, input) => {
			const row = (result ?? {}) as Record<string, unknown>;
			const verb = input.positionals[0];

			if (verb === "capabilities") {
				const supported = Array.isArray(row.supported) ? row.supported : [];
				const unsupported = Array.isArray(row.unsupported)
					? row.unsupported
					: [];
				return [
					`Browser automation: ${row.available ? "available" : "NOT available in this build"}`,
					`Supported: ${supported.join(", ") || "none"}`,
					`Unsupported: ${unsupported.join(", ") || "none"}`,
				].join("\n");
			}
			if (verb === "screenshot") return String(row.path ?? "");
			if (verb === "info") {
				return [
					`Pane:  ${String(row.paneId ?? "?")}`,
					`URL:   ${String(row.url ?? "")}`,
					`Title: ${String(row.title ?? "")}`,
				].join("\n");
			}
			if (verb === "fill") {
				const filled = Array.isArray(row.filled) ? row.filled : [];
				return `Filled ${String(row.count ?? filled.length)} field(s): ${filled.join(", ")}`;
			}
			if (verb === "navigate") {
				return `Navigated ${String(row.paneId ?? "?")} to ${String(row.url ?? "")}`;
			}
			if (verb === "open") {
				return `Opened browser pane ${String(row.paneId ?? row.id ?? "?")}`;
			}
			return `${verb === "click" ? "Clicked" : "Typed into"} ${String(row.selector ?? "?")} in ${String(row.paneId ?? "?")}`;
		},
	},
];
