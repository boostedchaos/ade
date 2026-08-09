import { GLOBAL_OPTIONS, type OptionDef } from "./args";
import type { Command } from "./command";
import { COMMANDS, GROUP_ORDER } from "./commands";

export const VERSION = "0.1.0";

function optionSignature(def: OptionDef): string {
	const short = def.short ? `-${def.short}, ` : "";
	if (def.type === "boolean") return `${short}--${def.name}`;
	const placeholder = def.placeholder ?? `<${def.name}>`;
	return `${short}--${def.name} ${placeholder}`;
}

function pad(rows: [string, string][], indent = "  "): string {
	const width = Math.max(0, ...rows.map(([left]) => left.length));
	return rows
		.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`)
		.join("\n");
}

export function commandUsage(command: Command): string {
	const parts = ["ade", command.name];
	if (command.rawArgs) parts.push("<args...>");
	for (const positional of command.positionals ?? []) {
		const label = positional.rest ? `${positional.name}...` : positional.name;
		parts.push(positional.required === false ? `[${label}]` : `<${label}>`);
	}
	if ((command.options ?? []).length > 0) parts.push("[options]");
	return parts.join(" ");
}

export function commandHelp(command: Command): string {
	const sections: string[] = [
		command.summary,
		"",
		`Usage: ${commandUsage(command)}`,
	];

	const positionals = command.positionals ?? [];
	if (positionals.length > 0) {
		sections.push("", "Arguments:");
		sections.push(pad(positionals.map((p) => [`<${p.name}>`, p.description])));
	}

	const options = [...(command.options ?? []), ...GLOBAL_OPTIONS];
	if (options.length > 0) {
		sections.push("", "Options:");
		sections.push(
			pad(
				options.map((option) => [
					optionSignature(option),
					option.required
						? `${option.description} (required)`
						: option.description,
				]),
			),
		);
	}

	if (command.notes) sections.push("", command.notes);
	return sections.join("\n");
}

export function topLevelHelp(): string {
	const sections: string[] = [
		"ade — drive the ADE app from the command line",
		"",
		"Usage: ade <command> [options]",
	];

	const groups = [
		...GROUP_ORDER,
		...new Set(
			COMMANDS.map((c) => c.group).filter((g) => !GROUP_ORDER.includes(g)),
		),
	];
	for (const group of groups) {
		const commands = COMMANDS.filter((c) => c.group === group);
		if (commands.length === 0) continue;
		sections.push("", `${group}:`);
		sections.push(pad(commands.map((c) => [c.name, c.summary])));
	}

	sections.push(
		"",
		"Global options:",
		pad([
			["--json", "Print the raw JSON result instead of human-readable text"],
			["-h, --help", "Show help for a command"],
			["--version", "Print the CLI version"],
		]),
		"",
		"Targets accept a UUID, a ref (workspace:1, tab:2, pane:3), or `focused`.",
		"Refs are 1-based positions in current UI order and are not stable across",
		"layout changes. They count within the FOCUSED context — tab:<n> within",
		"the focused workspace, pane:<n> within the focused tab — so indices from",
		"`list-tabs --workspace <other>` must be used as ids, not as refs.",
		"Resolution happens inside ADE, not in the CLI.",
		"",
		"Exit codes: 0 ok · 1 command failed · 2 usage or unsupported · 3 ADE not running",
	);
	return sections.join("\n");
}
