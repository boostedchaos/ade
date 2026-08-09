/**
 * Shell quoting for the pane-start command channel.
 *
 * SPEC hard rule (from cmux's public postmortem): wrap EVERY pane start
 * command in `/bin/sh -c '<single-quoted command>'` unconditionally. Never
 * try to classify which commands need a shell — Claude Code teammates respawn
 * with `cd <dir> && env … claude …`, which a bare exec fails silently on.
 */

/**
 * POSIX single-quoting. Inside '…' every byte is literal, so the only
 * character needing work is the quote itself: close, escape, reopen.
 */
export function singleQuote(value: string): string {
	return `'${value.split("'").join("'\\''")}'`;
}

/** The unconditional wrapper. */
export function shWrap(command: string): string {
	return `/bin/sh -c ${singleQuote(command)}`;
}

/**
 * What tmux-compat types into a placeholder pane's shell for `respawn-pane`.
 *
 * `exec` replaces the placeholder shell with the teammate process, so the
 * pane has exactly one process and kill/exit semantics match tmux's respawn:
 * closing the pane kills the teammate, and the teammate exiting ends the pane
 * rather than dropping back to a shell prompt.
 *
 * A raw newline inside the single-quoted body is safe when typed at an
 * interactive prompt: the quote is still open, so the shell reads a
 * continuation line rather than executing early.
 */
export function execLine(command: string): string {
	return `exec ${shWrap(command)}`;
}
