/**
 * Placeholders for command groups later phases fill in. They exist now so the
 * dispatch table, `ade --help`, and the exit-code contract are stable: calling
 * one prints "not yet implemented" and exits 2 (unsupported), never 0.
 */
import type { Command } from "../command";

interface StubSpec {
	name: string;
	group: string;
	summary: string;
	phase: string;
}

const STUBS: StubSpec[] = [
	{
		name: "hooks",
		group: "Not yet implemented",
		summary:
			"Manage Claude Code hook wiring (hooks setup claude | hooks status)",
		phase: "Phase 2 — agent session tracking",
	},
	{
		name: "agent-event",
		group: "Not yet implemented",
		summary: "Report an agent lifecycle event (called by Claude Code hooks)",
		phase: "Phase 2 — agent session tracking",
	},
	{
		name: "set-status",
		group: "Not yet implemented",
		summary: "Set a pane's agent status (working | needsInput | idle)",
		phase: "Phase 2 — agent session tracking",
	},
	{
		name: "set-progress",
		group: "Not yet implemented",
		summary: "Set a pane's progress indicator (0-100 | clear)",
		phase: "Phase 2 — agent session tracking",
	},
	{
		name: "agent-sessions",
		group: "Not yet implemented",
		summary: "List tracked agent sessions, one per terminal pane",
		phase: "Phase 2 — agent session tracking",
	},
	{
		name: "notify",
		group: "Not yet implemented",
		summary: "Raise a notification against a pane",
		phase: "Phase 3 — attention notifications",
	},
	{
		name: "list-notifications",
		group: "Not yet implemented",
		summary: "List notifications, newest first",
		phase: "Phase 3 — attention notifications",
	},
	{
		name: "mark-notification-read",
		group: "Not yet implemented",
		summary: "Mark one notification read, or all of them",
		phase: "Phase 3 — attention notifications",
	},
	{
		name: "jump-to-unread",
		group: "Not yet implemented",
		summary: "Focus the next pane with unread attention",
		phase: "Phase 3 — attention notifications",
	},
	{
		name: "claude-teams",
		group: "Not yet implemented",
		summary: "Launch Claude Code with agent-teams pointed at ADE's tmux shim",
		phase: "Phase 4 — teams shim",
	},
	{
		name: "tmux-compat",
		group: "Not yet implemented",
		summary: "Internal: tmux vocabulary shim target",
		phase: "Phase 4 — teams shim",
	},
	{
		name: "todo",
		group: "Not yet implemented",
		summary: "Workspace todos (add | list | start | done | rm)",
		phase: "Phase 5 — parity extras",
	},
	{
		name: "browser",
		group: "Not yet implemented",
		summary:
			"Drive a browser pane (open | navigate | click | type | screenshot)",
		phase: "Phase 5 — parity extras",
	},
	{
		name: "cli",
		group: "Not yet implemented",
		summary: "Manage the ade bin itself (cli install — put `ade` on PATH)",
		phase: "Phase 5 — parity extras",
	},
];

export const stubCommands: Command[] = STUBS.map((stub) => ({
	name: stub.name,
	group: stub.group,
	summary: stub.summary,
	kind: "stub" as const,
	rawArgs: true,
	notes: `Not yet implemented — lands in ${stub.phase}.`,
}));

export const stubPhase = (name: string): string | undefined =>
	STUBS.find((s) => s.name === name)?.phase;
