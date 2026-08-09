/**
 * Agent session tracking commands (Mission Control Feature 2).
 *
 * `agent-event` is the one command in the CLI that is allowed to fail silently.
 * Claude Code runs it from a hook on every prompt and every tool call, inside
 * and outside ADE; if it ever printed an error or returned non-zero it would
 * dirty the agent's transcript or break the hook. So it exits 0 and says
 * nothing whenever it cannot do its job — no socket, no ADE_SURFACE_ID, server
 * refused, anything. `kind: "silent"` in run.ts is what enforces that.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Command, compact } from "../command";
import { usageError } from "../errors";
import { formatResult } from "../output";
import { getAdeDirName } from "../socket-path";

/**
 * ADE's own claude hooks file. Duplicated from server-core's HOOKS_DIR for the
 * same reason socket-path.ts duplicates the socket derivation: the CLI is a
 * standalone bin that must not pull server-core into its module graph. Keep the
 * two in sync.
 */
function claudeSettingsPath(): string {
	return join(homedir(), getAdeDirName(), "hooks", "claude-settings.json");
}

/** The event set ADE's hooks file is expected to register. */
const EXPECTED_HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Notification",
	"PermissionRequest",
	"Stop",
	"SessionEnd",
];

/** The pane the calling process is running in. Set by ADE's PTY env injection. */
const SURFACE_ID_VAR = "ADE_SURFACE_ID";
const WORKSPACE_ID_VAR = "ADE_WORKSPACE_ID";

const HOOK_AGENTS = ["claude", "codex", "opencode"];

export const sessionCommands: Command[] = [
	{
		name: "agent-sessions",
		group: "Agent sessions",
		summary: "List tracked agent sessions, one per terminal pane",
		kind: "request",
		notes:
			"State is driven by agent hooks, never by reading the screen. A session\n" +
			"stuck in `working` with no hook for 10 minutes is re-checked against the\n" +
			"agent's transcript and corrected.",
		build: () => ({ cmd: "agent-sessions", args: {} }),
		format: (result) => {
			const sessions = (result as { sessions?: unknown[] } | null)?.sessions;
			if (!Array.isArray(sessions) || sessions.length === 0) {
				return "No agent sessions tracked.";
			}
			return formatResult(
				sessions.map((session) => {
					const row = session as Record<string, unknown>;
					const last = row.lastActivityAt;
					return {
						...row,
						lastActivityAt:
							typeof last === "number" ? new Date(last).toISOString() : last,
					};
				}),
			);
		},
	},

	{
		name: "agent-event",
		group: "Agent sessions",
		summary: "Report an agent lifecycle event (called by Claude Code hooks)",
		kind: "silent",
		options: [
			{
				name: "event",
				type: "string",
				required: true,
				placeholder: "<name>",
				description:
					"Hook event name (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SessionEnd)",
			},
			{
				name: "session-id",
				type: "string",
				placeholder: "<id>",
				description: "The agent CLI's own session id",
			},
			{
				name: "transcript-path",
				type: "string",
				placeholder: "<path>",
				description: "Conversation JSONL, used to correct stuck states",
			},
			{
				name: "surface-id",
				type: "string",
				placeholder: "<paneId>",
				description: `Pane to attribute the event to (default: $${SURFACE_ID_VAR})`,
			},
		],
		notes:
			`Reads $${SURFACE_ID_VAR} / $${WORKSPACE_ID_VAR} from the environment ADE\n` +
			"injects into every pane. ALWAYS exits 0 and prints nothing — outside ADE,\n" +
			"or with the app closed, it is a no-op, so hooks that call it are safe to\n" +
			"install globally.",
		build: (input) => {
			const surfaceId =
				(input.options["surface-id"] as string | undefined) ||
				process.env[SURFACE_ID_VAR];
			// Swallowed by the silent runner; the message only ever shows up if
			// someone runs this command under a debugger.
			if (!surfaceId) throw usageError(`${SURFACE_ID_VAR} is not set`);

			return {
				cmd: "agent-event",
				args: compact({
					surfaceId,
					event: input.options.event,
					workspaceId: process.env[WORKSPACE_ID_VAR] || undefined,
					sessionId: input.options["session-id"],
					transcriptPath: input.options["transcript-path"],
				}),
			};
		},
	},

	{
		name: "hooks",
		group: "Agent sessions",
		summary:
			"Manage ADE's agent hook wiring (hooks setup claude | hooks status)",
		kind: "request",
		positionals: [
			{
				name: "subcommand",
				description: "setup | status",
				required: true,
			},
			{
				name: "agent",
				description: `Agent to act on: ${HOOK_AGENTS.join(" | ")} (default: claude)`,
				required: false,
			},
		],
		notes:
			"`setup` rewrites ADE's own hooks file (~/.ade/hooks/claude-settings.json,\n" +
			"forced with `claude --settings`) and prints the backup path when it\n" +
			"replaced different content. ADE never edits ~/.claude/settings.json.\n" +
			"`status` reports which hook events are wired and whether ADE is running.\n" +
			"codex and opencode are not yet supported and exit 2.",
		build: (input) => {
			const subcommand = input.positionals[0];
			const agent = input.positionals[1] ?? "claude";
			if (subcommand !== "setup" && subcommand !== "status") {
				throw usageError(
					`ade hooks: expected "setup" or "status", got "${subcommand ?? ""}"`,
				);
			}
			return {
				cmd: subcommand === "setup" ? "hooks-setup" : "hooks-status",
				args: { agent },
			};
		},
		format: (result, input) => {
			const row = (result ?? {}) as Record<string, unknown>;
			const lines: string[] = [];
			const missing = Array.isArray(row.missing) ? row.missing : [];
			const registered = Array.isArray(row.registered) ? row.registered : [];

			if (input.positionals[0] === "setup") {
				lines.push(
					row.changed
						? `Wrote hooks file: ${row.settingsPath}`
						: `Hooks file already current: ${row.settingsPath}`,
				);
				if (typeof row.backupPath === "string") {
					lines.push(`Previous file backed up to: ${row.backupPath}`);
				}
			} else {
				// Reaching format() at all means the socket answered.
				lines.push("ADE control socket: reachable");
				lines.push(
					row.present
						? `Hooks file: present (${row.settingsPath})`
						: `Hooks file: MISSING (${row.settingsPath ?? "n/a"})`,
				);
			}

			lines.push(
				`Events wired (${registered.length}): ${registered.join(", ") || "none"}`,
			);
			if (missing.length > 0) {
				lines.push(`Events MISSING (${missing.length}): ${missing.join(", ")}`);
			}
			return lines.join("\n");
		},
		/**
		 * With ADE closed, `hooks status` can still answer most of the question
		 * from disk. `hooks setup` cannot — it needs the app to rewrite the file
		 * with the right notify-script path — so it keeps the exit-3 contract.
		 */
		offlineFallback: (input) => {
			if (input.positionals[0] !== "status") return null;
			const settingsPath = claudeSettingsPath();
			let present = false;
			let registered: string[] = [];
			try {
				const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
					hooks?: Record<string, unknown>;
				};
				present = true;
				const hooks = parsed.hooks ?? {};
				registered = EXPECTED_HOOK_EVENTS.filter(
					(name) =>
						Array.isArray(hooks[name]) && (hooks[name] as unknown[]).length > 0,
				);
			} catch {
				// Missing or unparseable: reported below as no coverage.
			}
			const missing = EXPECTED_HOOK_EVENTS.filter(
				(name) => !registered.includes(name),
			);
			const lines = [
				"ADE control socket: NOT reachable (app not running)",
				present
					? `Hooks file: present (${settingsPath})`
					: `Hooks file: MISSING (${settingsPath})`,
				`Events wired (${registered.length}): ${registered.join(", ") || "none"}`,
			];
			if (missing.length > 0) {
				lines.push(`Events MISSING (${missing.length}): ${missing.join(", ")}`);
			}
			return lines.join("\n");
		},
	},
];
