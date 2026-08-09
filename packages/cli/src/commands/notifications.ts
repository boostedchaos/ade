/**
 * Attention notification commands (Mission Control Feature 3).
 *
 * `notify` is the one an agent calls; the other three are for Kyle at a
 * terminal. All four are ordinary `request` commands — unlike `agent-event`
 * they are not on an agent's critical path, so a closed app should say so
 * (exit 3) rather than pretend to have worked.
 */
import { type Command, compact } from "../command";
import { usageError } from "../errors";
import { formatResult } from "../output";

const SURFACE_ID_VAR = "ADE_SURFACE_ID";

interface NotificationRow {
	id?: unknown;
	kind?: unknown;
	title?: unknown;
	body?: unknown;
	paneId?: unknown;
	createdAt?: unknown;
	readAt?: unknown;
}

function formatNotifications(result: unknown): string {
	const rows = (result as { notifications?: unknown } | null)?.notifications;
	if (!Array.isArray(rows) || rows.length === 0) {
		return "No notifications.";
	}
	return formatResult(
		rows.map((row) => {
			const record = row as NotificationRow;
			return {
				id: record.id,
				read: record.readAt === null ? "UNREAD" : "read",
				kind: record.kind,
				title: record.title,
				pane: record.paneId ?? "",
				created:
					typeof record.createdAt === "number"
						? new Date(record.createdAt).toISOString()
						: record.createdAt,
			};
		}),
	);
}

export const notificationCommands: Command[] = [
	{
		name: "notify",
		group: "Notifications",
		summary: "Raise a notification, optionally against a pane",
		kind: "request",
		options: [
			{
				name: "title",
				type: "string",
				required: true,
				placeholder: "<text>",
				description: "Headline shown in the panel and the OS notification",
			},
			{
				name: "body",
				type: "string",
				placeholder: "<text>",
				description: "Longer detail line (optional)",
			},
			{
				name: "pane",
				type: "string",
				placeholder: "<pane>",
				description:
					`Pane the notification is about: id, pane:<n>, or "focused". ` +
					`Defaults to $${SURFACE_ID_VAR} when set (so an agent's own pane is used).`,
			},
		],
		notes:
			`With no --pane and no $${SURFACE_ID_VAR}, the notification has no pane and\n` +
			"clicking it only raises the window. Notifications raised this way show a\n" +
			"native OS notification; the automatic ones an agent generates by asking\n" +
			"for permission already have their own.",
		build: (input) => ({
			cmd: "notify",
			args: compact({
				title: input.options.title,
				body: input.options.body,
				// An agent calling `ade notify` from inside its pane means "about me",
				// which is what the injected env already says. Explicit --pane wins.
				pane:
					(input.options.pane as string | undefined) ||
					process.env[SURFACE_ID_VAR] ||
					undefined,
			}),
		}),
		format: (result) => {
			const row = (result ?? {}) as NotificationRow;
			return `Notification raised (${String(row.id ?? "?")}): ${String(row.title ?? "")}`;
		},
	},

	{
		name: "list-notifications",
		group: "Notifications",
		summary: "List notifications, newest first",
		kind: "request",
		options: [
			{
				name: "unread",
				type: "boolean",
				description: "Only notifications that have not been read",
			},
		],
		build: (input) => ({
			cmd: "list-notifications",
			args: compact({
				unread: input.options.unread === true ? true : undefined,
			}),
		}),
		format: formatNotifications,
	},

	{
		name: "mark-notification-read",
		group: "Notifications",
		summary: "Mark one notification read, or all of them",
		kind: "request",
		positionals: [
			{
				name: "id",
				description: "Notification id (omit when using --all)",
				required: false,
			},
		],
		options: [
			{
				name: "all",
				type: "boolean",
				description: "Mark every unread notification read",
			},
		],
		build: (input) => {
			const all = input.options.all === true;
			const id = input.positionals[0];
			if (all && id) {
				throw usageError("Pass an id or --all, not both");
			}
			if (!all && !id) {
				throw usageError("Pass a notification id, or --all");
			}
			return {
				cmd: "mark-notification-read",
				args: all ? { all: true } : { id },
			};
		},
		format: (result) => {
			const row = (result ?? {}) as { marked?: unknown; all?: unknown };
			const marked = typeof row.marked === "number" ? row.marked : 0;
			if (row.all === true) {
				return marked === 0
					? "Nothing was unread."
					: `Marked ${marked} notification${marked === 1 ? "" : "s"} read.`;
			}
			return marked === 0
				? "Not marked — no such unread notification."
				: "Marked read.";
		},
	},

	{
		name: "jump-to-unread",
		group: "Notifications",
		summary: "Focus the next pane with unread attention",
		kind: "request",
		notes:
			"Cycles through panes that have an unread attention notification, newest\n" +
			"ask first, wrapping at the end. The position is derived from what has\n" +
			"focus right now, so it stays in step with panes you click yourself.\n" +
			"Jumping does not mark anything read — the notification clears when the\n" +
			"agent stops waiting.",
		build: () => ({ cmd: "jump-to-unread", args: {} }),
		format: (result) => {
			const row = (result ?? {}) as { jumped?: unknown; paneId?: unknown };
			return row.jumped === true
				? `Focused pane ${String(row.paneId)}`
				: "No panes are waiting on you.";
		},
	},
];
