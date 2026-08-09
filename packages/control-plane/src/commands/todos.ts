import { optionalString, requireEnum, requireString } from "../args";
import type { TodoStateName, TodosHost } from "../host";
import { ControlError } from "../protocol";
import type { AuthenticatedSession, CommandRegistry } from "../server";
import { resolveTarget } from "../target-resolution";

/**
 * Todos group (Mission Control Feature 1).
 *
 * Deliberately emits NOTHING on the event bus in v1. Every other feature's
 * events have a consumer (`ade events`, the ring, the badges); a todo has none
 * yet, and publishing a kind no client reads would freeze a wire contract
 * before anything has told us what shape it should be.
 *
 * The `--workspace` argument goes through the ordinary target resolver, so
 * `workspace:2` and `focused` work here exactly as they do for `new-tab`. The
 * mutating verbs take a todo UUID instead: a todo has no position in the UI to
 * count from, so there is no ref form to support.
 */

const TODO_STATES = ["pending", "in-progress", "completed"] as const;

function requireTodos(session: AuthenticatedSession): TodosHost {
	const todos = session.host.todos;
	if (!todos) {
		throw new ControlError(
			"UNSUPPORTED",
			"This ADE build does not track todos",
		);
	}
	return todos;
}

function resolveWorkspace(
	session: AuthenticatedSession,
	args: Record<string, unknown>,
): string {
	return resolveTarget(
		session.host.getSnapshot(),
		"workspace",
		requireString(args, "workspace"),
	);
}

/** Shared by todo-start / todo-done: same body, different target state. */
function transition(
	session: AuthenticatedSession,
	args: Record<string, unknown>,
	state: TodoStateName,
) {
	const todos = requireTodos(session);
	const id = requireString(args, "id");
	const record = todos.setState(id, state);
	if (!record) {
		throw new ControlError("NOT_FOUND", `No todo with id ${id}`);
	}
	return record;
}

export const todoCommands: CommandRegistry = {
	"todo-add": (session, args) => {
		const todos = requireTodos(session);
		const title = requireString(args, "title");
		return todos.create({
			workspaceId: resolveWorkspace(session, args),
			title,
		});
	},

	"todo-list": (session, args) => {
		const todos = requireTodos(session);
		const workspaceId = resolveWorkspace(session, args);
		// An absent --state lists everything; a present one must be a real state
		// rather than silently matching nothing.
		const state = optionalString(args, "state")
			? requireEnum(args, "state", TODO_STATES)
			: undefined;

		const records = todos.list({ workspaceId, state });
		return {
			workspaceId,
			todos: records,
			counts: {
				pending: records.filter((t) => t.state === "pending").length,
				"in-progress": records.filter((t) => t.state === "in-progress").length,
				completed: records.filter((t) => t.state === "completed").length,
			},
		};
	},

	"todo-start": (session, args) => transition(session, args, "in-progress"),

	"todo-done": (session, args) => transition(session, args, "completed"),

	"todo-rm": (session, args) => {
		const todos = requireTodos(session);
		const id = requireString(args, "id");
		if (!todos.remove(id)) {
			throw new ControlError("NOT_FOUND", `No todo with id ${id}`);
		}
		return { removed: true, id };
	},
};
