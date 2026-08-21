/**
 * Stable error codes for the ACP host.
 *
 * The repo's cross-process convention is a string code turned into
 * `new Error(\`${code}: ${message}\`)` rather than a custom class per failure
 * (`terminal/errors.ts` is the single custom-class precedent and we do not add
 * another). Codes are stable so callers can branch on
 * `err.message.startsWith(code)`.
 */
export type AcpErrorCode =
	/** `getAcpBinaryPath()` called with no resolver registered. */
	| "acp-binary-unresolved"
	/**
	 * No Claude Code executable could be located for `CLAUDE_CODE_EXECUTABLE`.
	 * Raised by the HOST APP's resolver (the desktop shim), not by this module:
	 * the adapter is bundled without the SDK's vendored per-platform CLI, so the
	 * user's own installed `claude` is the runtime and its absence has to name
	 * itself rather than surface as a spawn failure 15 s later.
	 */
	| "acp-claude-not-found"
	/** Spawn error, or the child exited before `initialize` completed. */
	| "acp-spawn-failed"
	/** `initialize` / `session/new` exceeded ACP_STARTUP_TIMEOUT_MS. */
	| "acp-startup-timeout"
	/** A method was called with a paneId the host does not know. */
	| "acp-session-not-found"
	/** A method was called on a disposed or terminating session. */
	| "acp-session-disposed"
	/** The child exited unexpectedly (no teardown in progress). */
	| "acp-session-died"
	/** `setConfigOption` value is not in the option's declared `values`. */
	| "acp-invalid-config-value"
	/** `setMode` id is not in the session's declared `availableModes`. */
	| "acp-invalid-mode"
	/** `prompt()` called while a turn is already in flight on that session. */
	| "acp-prompt-in-flight"
	/** The ACP server answered a request with a JSON-RPC error. */
	| "acp-rpc-error";

/** Build a coded Error. The code is the message prefix, followed by `: `. */
export function acpError(code: AcpErrorCode, message: string): Error {
	return new Error(`${code}: ${message}`);
}
