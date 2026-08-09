/**
 * Wire contract for the ADE control socket.
 *
 * Source of truth: docs/specs/mission-control/PROTOCOL.md (Phase 0 decision,
 * 2026-08-09). This module is the executable copy of it and must not drift.
 *
 * Deliberate divergences from the terminal-host daemon (which this otherwise
 * mirrors) are listed in PROTOCOL.md § "Deliberate divergences":
 *  - responses carry `result`, not the daemon's `payload`
 *  - events upgrade one connection via `subscribe` rather than pairing a
 *    second `role: "stream"` socket
 *  - the token is regenerated per app launch
 *  - auth is one middleware, not a per-handler copy-paste
 */

/** Bumped only on a breaking wire change. Reported in the hello result. */
export const CONTROL_PROTOCOL_VERSION = 1;

/**
 * Closed set of error codes. A client may rely on this being exhaustive;
 * adding a member is a protocol change.
 */
export const CONTROL_ERROR_CODES = [
	"AUTH_FAILED",
	"AUTH_REQUIRED",
	"BAD_REQUEST",
	"NOT_FOUND",
	"UNSUPPORTED",
	"RENDERER_UNAVAILABLE",
	"TIMEOUT",
	"INTERNAL",
] as const;

export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

/** Every request line. `id` is echoed verbatim; clients may pipeline. */
export interface ControlRequest {
	id: string;
	cmd: string;
	args?: Record<string, unknown>;
	/** hello only. Never logged — see redactSecrets(). */
	token?: string;
	/** hello only. Free-form, e.g. "ade-cli/0.4.0". */
	client?: string;
}

export interface ControlSuccessResponse {
	id: string;
	ok: true;
	result: unknown;
}

export interface ControlErrorResponse {
	id: string;
	ok: false;
	error: { code: ControlErrorCode; message: string };
}

export type ControlResponse = ControlSuccessResponse | ControlErrorResponse;

export interface HelloResult {
	protocol: number;
	app: string;
}

/**
 * Event kinds pushed on a subscribed connection. `agent-state-changed` and
 * `notification` are declared here in v1 but only emitted from Phase 2/3 —
 * the bus accepts them today so those phases plug in without a wire change.
 */
export const CONTROL_EVENT_KINDS = [
	"pane-created",
	"pane-closed",
	"pane-focused",
	"agent-state-changed",
	"notification",
] as const;

export type ControlEventKind = (typeof CONTROL_EVENT_KINDS)[number];

export interface ControlEvent {
	event: ControlEventKind;
	/** ISO 8601. */
	ts: string;
	data: Record<string, unknown>;
}

export function isControlEventKind(value: unknown): value is ControlEventKind {
	return (
		typeof value === "string" &&
		(CONTROL_EVENT_KINDS as readonly string[]).includes(value)
	);
}

/**
 * An error a handler can throw to produce a specific wire error code.
 * Anything else escaping a handler becomes INTERNAL.
 */
export class ControlError extends Error {
	constructor(
		readonly code: ControlErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ControlError";
	}
}

export function successResponse(
	id: string,
	result: unknown,
): ControlSuccessResponse {
	return { id, ok: true, result };
}

export function errorResponse(
	id: string,
	code: ControlErrorCode,
	message: string,
): ControlErrorResponse {
	return { id, ok: false, error: { code, message } };
}

/**
 * Redaction for anything that reaches a log. The control socket carries a
 * token on its very first line, so a malformed-hello log would otherwise
 * print it. Same shape as the terminal-host daemon's parser redaction.
 */
export function redactSecrets(text: string): string {
	return text.replace(
		/("?(?:token|secret|password|key|auth)"?\s*[:=]\s*"?)([^",}\s]+)/gi,
		"$1<redacted>",
	);
}

/** Truncate + redact, for logging an unparseable line. */
export function previewLine(line: string, maxLength = 100): string {
	const clipped =
		line.length > maxLength ? `${line.slice(0, maxLength)}…` : line;
	return redactSecrets(clipped);
}
