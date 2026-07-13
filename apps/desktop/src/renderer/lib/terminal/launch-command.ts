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
}

function normalizeTerminalCommand(command: string): string {
	return command.endsWith("\n") ? command : `${command}\n`;
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
}: LaunchCommandInPaneOptions): Promise<void> {
	await createOrAttach({
		paneId,
		tabId,
		workspaceId,
	});

	await writeCommandInPane({ paneId, command, write });
}
