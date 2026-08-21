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
	/** The ACP server answered a request with a JSON-RPC error. */
	| "acp-rpc-error";

/** Build a coded Error. The code is the message prefix, followed by `: `. */
export function acpError(code: AcpErrorCode, message: string): Error {
	return new Error(`${code}: ${message}`);
}
