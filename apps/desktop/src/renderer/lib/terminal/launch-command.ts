import { IS_WINDOWS } from "@superset/shared/agent-command";

interface TerminalCreateOrAttachInput {
	paneId: string;
	tabId: string;
	workspaceId: string;
}

interface TerminalWriteInput {
	paneId: string;
	data: string;
	throwOnError?: boolean;
}

interface LaunchCommandInPaneOptions {
	paneId: string;
	tabId: string;
	workspaceId: string;
	command: string;
	createOrAttach: (input: TerminalCreateOrAttachInput) => Promise<unknown>;
	write: (input: TerminalWriteInput) => Promise<unknown>;
	/** Beat to let a freshly-spawned shell start reading stdin before typing the
	 * command (issue #49). Only applied when a NEW shell was created. */
	settleMs?: number;
	/** Delay primitive (overridable for tests). */
	delay?: (ms: number) => Promise<void>;
}

/**
 * A freshly-spawned shell may not be reading stdin yet; typing the launch
 * command immediately can drop or garble it so nothing starts (issue #49,
 * "claude never starts"). Give a newly-created shell this long to settle first.
 * Warm attaches (an already-running shell) skip the wait.
 */
export const DEFAULT_SHELL_SETTLE_MS = 300;

function defaultDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when createOrAttach reports it spawned a NEW shell (vs. warm-attaching
 * to a live one). Only a new shell needs the readiness settle. */
function isFreshShell(result: unknown): boolean {
	return (
		!!result &&
		typeof result === "object" &&
		(result as { isNew?: unknown }).isNew === true
	);
}

function normalizeTerminalCommand(command: string): string {
	// A terminal submits a line on carriage return (\r = Enter), not newline.
	// Writing \n leaves the command staged in the prompt but unexecuted — the
	// shell only runs it once it sees \r (matches the Enter key, which sends
	// "\r"; see TerminalKeyBar). Normalize any trailing newline(s) to a single
	// \r so the launch actually runs (issue #49).
	return command.endsWith("\r")
		? command
		: `${command.replace(/[\r\n]+$/, "")}\r`;
}

interface WriteCommandInPaneOptions {
	paneId: string;
	command: string;
	write: (input: TerminalWriteInput) => Promise<unknown>;
}

interface WriteCommandsInPaneOptions {
	paneId: string;
	commands: string[] | null | undefined;
	write: (input: TerminalWriteInput) => Promise<unknown>;
}

export function buildTerminalCommand(
	commands: string[] | null | undefined,
	isWindows: boolean = IS_WINDOWS,
): string | null {
	if (!Array.isArray(commands) || commands.length === 0) return null;
	// Windows panes run PowerShell (pwsh 7 or Windows PowerShell 5.1 — see
	// agent-command.ts; cmd-only sessions are out of scope). `&&` is a parse
	// error in 5.1, so chain with a fail-fast check both versions accept:
	// `throw` aborts the rest of the line but keeps the interactive pane alive.
	if (isWindows) {
		return commands.join('; if (-not $?) { throw "command failed" }; ');
	}
	return commands.join(" && ");
}

export async function writeCommandInPane({
	paneId,
	command,
	write,
}: WriteCommandInPaneOptions): Promise<void> {
	await write({
		paneId,
		data: normalizeTerminalCommand(command),
		throwOnError: true,
	});
}

export async function writeCommandsInPane({
	paneId,
	commands,
	write,
}: WriteCommandsInPaneOptions): Promise<void> {
	const command = buildTerminalCommand(commands);
	if (!command) return;
	await writeCommandInPane({ paneId, command, write });
}

export async function launchCommandInPane({
	paneId,
	tabId,
	workspaceId,
	command,
	createOrAttach,
	write,
	settleMs = DEFAULT_SHELL_SETTLE_MS,
	delay = defaultDelay,
}: LaunchCommandInPaneOptions): Promise<void> {
	const session = await createOrAttach({
		paneId,
		tabId,
		workspaceId,
	});

	// Let a freshly-spawned shell begin reading stdin before we type the command
	// so the launch isn't dropped/garbled by the startup race (issue #49). Warm
	// attaches to an already-running shell write immediately (no regression).
	if (settleMs > 0 && isFreshShell(session)) {
		await delay(settleMs);
	}

	await writeCommandInPane({ paneId, command, write });
}
