/**
 * Per-workspace todo lists (Mission Control Feature 1, Todos group).
 *
 * Same shape as the attention store next door and for the same reason: a thin
 * synchronous wrapper over one table rather than an in-memory registry with a
 * snapshot behind it. Todos are written by hand (or by an agent between tool
 * calls) a few times a minute at most, and better-sqlite3 is synchronous, so a
 * query per read costs less than the staleness a cache would introduce.
 *
 * Unlike notifications, writes here are NOT best-effort-silent. A todo command
 * is a direct request from a caller who is waiting for an answer, so a failed
 * write raises and the control-plane command reports INTERNAL — silently
 * dropping `todo add` would leave the agent believing it recorded work it did
 * not record.
 */
import { workspaceTodos } from "@superset/local-db";
import { and, asc, eq, max } from "drizzle-orm";
import { localDb } from "../local-db";

export type TodoState = "pending" | "in-progress" | "completed";

export const TODO_STATES: readonly TodoState[] = [
	"pending",
	"in-progress",
	"completed",
];

export interface TodoRecord {
	id: string;
	workspaceId: string;
	title: string;
	state: TodoState;
	sortOrder: number;
	createdAt: number;
	updatedAt: number;
	completedAt: number | null;
}

function toState(value: string): TodoState {
	return (TODO_STATES as readonly string[]).includes(value)
		? (value as TodoState)
		: "pending";
}

function toRecord(row: {
	id: string;
	workspaceId: string;
	title: string;
	state: string;
	sortOrder: number;
	createdAt: number;
	updatedAt: number;
	completedAt: number | null;
}): TodoRecord {
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		title: row.title,
		state: toState(row.state),
		sortOrder: row.sortOrder,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		completedAt: row.completedAt ?? null,
	};
}

/**
 * Oldest first within a workspace: a todo list is a queue, and the thing filed
 * first is the thing to do first. `sortOrder` leads so an explicit reorder
 * (not yet exposed on the CLI) would take effect without touching timestamps.
 */
export function listTodos(options: {
	workspaceId: string;
	state?: TodoState;
}): TodoRecord[] {
	const where = options.state
		? and(
				eq(workspaceTodos.workspaceId, options.workspaceId),
				eq(workspaceTodos.state, options.state),
			)
		: eq(workspaceTodos.workspaceId, options.workspaceId);

	return localDb
		.select()
		.from(workspaceTodos)
		.where(where)
		.orderBy(asc(workspaceTodos.sortOrder), asc(workspaceTodos.createdAt))
		.all()
		.map(toRecord);
}

export function getTodo(id: string): TodoRecord | null {
	const row = localDb
		.select()
		.from(workspaceTodos)
		.where(eq(workspaceTodos.id, id))
		.get();
	return row ? toRecord(row) : null;
}

/**
 * Append to the end of a workspace's list.
 *
 * The max+1 read and the insert are NOT in a transaction because the control
 * socket serialises commands onto one main-process thread — there is no second
 * writer to race with. A duplicate sortOrder would only tie in the ordering
 * anyway, which createdAt then breaks.
 */
export function createTodo(input: {
	workspaceId: string;
	title: string;
}): TodoRecord {
	const highest = localDb
		.select({ value: max(workspaceTodos.sortOrder) })
		.from(workspaceTodos)
		.where(eq(workspaceTodos.workspaceId, input.workspaceId))
		.get();

	const now = Date.now();
	const [row] = localDb
		.insert(workspaceTodos)
		.values({
			workspaceId: input.workspaceId,
			title: input.title,
			state: "pending",
			sortOrder: (highest?.value ?? 0) + 1,
			createdAt: now,
			updatedAt: now,
		})
		.returning()
		.all();

	if (!row) throw new Error("Todo insert returned no row");
	return toRecord(row);
}

/**
 * Move a todo to a state. Returns null when no such id exists, so the caller
 * can answer NOT_FOUND rather than pretending it worked.
 *
 * `completedAt` is derived from the target state in both directions: moving to
 * `completed` stamps it, moving away clears it. Leaving a stale completedAt on
 * a reopened todo would make "when was this finished" answer for a todo that
 * is not finished.
 */
export function setTodoState(id: string, state: TodoState): TodoRecord | null {
	const now = Date.now();
	const [row] = localDb
		.update(workspaceTodos)
		.set({
			state,
			updatedAt: now,
			completedAt: state === "completed" ? now : null,
		})
		.where(eq(workspaceTodos.id, id))
		.returning()
		.all();
	return row ? toRecord(row) : null;
}

/** True when a row was actually deleted. */
export function deleteTodo(id: string): boolean {
	const rows = localDb
		.delete(workspaceTodos)
		.where(eq(workspaceTodos.id, id))
		.returning({ id: workspaceTodos.id })
		.all();
	return rows.length > 0;
}
