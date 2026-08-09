/**
 * Workspace todos (Mission Control Feature 1, Todos group).
 *
 * One CLI verb (`todo`) with subcommands, following the `hooks` precedent, but
 * five distinct wire commands (`todo-add`, `todo-list`, …) because the server
 * keeps one handler per operation.
 *
 * `--workspace` defaults to `focused` here even though the server requires it
 * explicitly. That asymmetry is deliberate and matches the server's own
 * reasoning for the opposite choice on `set-status`: a todo is a note about the
 * workspace a human is looking at, so defaulting is what they mean; an agent
 * status is a claim about a specific pane, so defaulting would let one agent
 * overwrite another's state.
 */
import { type Command, compact } from "../command";
import { usageError } from "../errors";
import { formatResult } from "../output";

const SUBCOMMANDS = ["add", "list", "start", "done", "rm"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const TODO_STATES = ["pending", "in-progress", "completed"] as const;

const WIRE_COMMAND: Record<Subcommand, string> = {
	add: "todo-add",
	list: "todo-list",
	start: "todo-start",
	done: "todo-done",
	rm: "todo-rm",
};

interface TodoRow {
	id?: unknown;
	title?: unknown;
	state?: unknown;
}

function parseSubcommand(value: string | undefined): Subcommand {
	if (
		value !== undefined &&
		(SUBCOMMANDS as readonly string[]).includes(value)
	) {
		return value as Subcommand;
	}
	throw usageError(
		`ade todo: expected one of ${SUBCOMMANDS.join(" | ")}, got "${value ?? ""}"`,
	);
}

function formatList(result: unknown): string {
	const row = (result ?? {}) as {
		todos?: unknown;
		counts?: Record<string, unknown>;
	};
	const todos = Array.isArray(row.todos) ? (row.todos as TodoRow[]) : [];
	const counts = row.counts ?? {};
	const summary = [
		`${String(counts.pending ?? 0)} pending`,
		`${String(counts["in-progress"] ?? 0)} in-progress`,
		`${String(counts.completed ?? 0)} completed`,
	].join(", ");

	if (todos.length === 0) return `No todos. (${summary})`;
	return `${formatResult(todos)}\n\n${summary}`;
}

function formatOne(result: unknown, verb: string): string {
	const row = (result ?? {}) as TodoRow;
	return `${verb} ${String(row.id ?? "?")}: ${String(row.title ?? "")} [${String(row.state ?? "?")}]`;
}

export const todoCommands: Command[] = [
	{
		name: "todo",
		group: "Todos",
		summary: "Workspace todos (add | list | start | done | rm)",
		kind: "request",
		positionals: [
			{
				name: "subcommand",
				description: SUBCOMMANDS.join(" | "),
				required: true,
			},
			{
				name: "argument",
				description:
					"Title for `add`, todo id for `start` / `done` / `rm`, nothing for `list`",
				rest: true,
				required: false,
			},
		],
		options: [
			{
				name: "workspace",
				type: "string",
				placeholder: "<workspace>",
				description:
					"Workspace the todo belongs to: id, workspace:<n>, or `focused` (default)",
			},
			{
				name: "state",
				type: "string",
				choices: TODO_STATES,
				placeholder: TODO_STATES.join("|"),
				description: "`list` only: show just this state",
			},
		],
		notes:
			"Examples:\n" +
			'  ade todo add "wire up the badge counter"\n' +
			"  ade todo list --state in-progress\n" +
			"  ade todo start <id>\n\n" +
			"`--workspace` defaults to the focused workspace. The mutating verbs take\n" +
			"a todo UUID, not a ref: a todo has no position in the UI to count from.",
		build: (input) => {
			const subcommand = parseSubcommand(input.positionals[0]);
			const argument = input.positionals[1];
			const workspace =
				(input.options.workspace as string | undefined) ?? "focused";

			if (subcommand === "add") {
				if (!argument) throw usageError("ade todo add: a title is required");
				return { cmd: WIRE_COMMAND.add, args: { workspace, title: argument } };
			}

			if (subcommand === "list") {
				if (argument) {
					throw usageError(
						`ade todo list: unexpected argument "${argument}" (did you mean --state?)`,
					);
				}
				return {
					cmd: WIRE_COMMAND.list,
					args: compact({ workspace, state: input.options.state }),
				};
			}

			if (!argument) {
				throw usageError(`ade todo ${subcommand}: a todo id is required`);
			}
			return { cmd: WIRE_COMMAND[subcommand], args: { id: argument } };
		},
		format: (result, input) => {
			const subcommand = input.positionals[0];
			if (subcommand === "list") return formatList(result);
			if (subcommand === "rm") {
				const row = (result ?? {}) as { id?: unknown };
				return `Removed todo ${String(row.id ?? "?")}`;
			}
			const verb = subcommand === "add" ? "Added" : "Updated";
			return formatOne(result, verb);
		},
	},
];
