/**
 * Exit codes are part of the CLI's contract with agents and scripts.
 * See docs/specs/mission-control/PROTOCOL.md "CLI exit codes".
 */
export const EXIT = {
	OK: 0,
	/** Server answered ok:false, or the connection failed after handshake. */
	SERVER_ERROR: 1,
	/** Bad usage, unknown command, or unsupported platform. */
	USAGE: 2,
	/** No control socket / no token — the ADE app is not running. */
	NOT_RUNNING: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
	readonly code: ExitCode;
	/** Server-side error code (`NOT_FOUND`, `UNSUPPORTED`, …) when there is one. */
	readonly serverCode?: string;

	constructor(code: ExitCode, message: string, serverCode?: string) {
		super(message);
		this.name = "CliError";
		this.code = code;
		this.serverCode = serverCode;
	}
}

export const usageError = (message: string): CliError =>
	new CliError(EXIT.USAGE, message);

export const notRunningError = (): CliError =>
	new CliError(EXIT.NOT_RUNNING, "ADE app is not running (no control socket)");

export const serverError = (message: string, serverCode?: string): CliError =>
	new CliError(EXIT.SERVER_ERROR, message, serverCode);
