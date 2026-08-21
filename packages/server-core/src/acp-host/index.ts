/**
 * ACP host — the main-process side of the Claude Code ACP integration.
 *
 * One long-lived `claude-agent-acp` child per pane, speaking ACP (JSON-RPC over
 * NDJSON on stdio) through `@agentclientprotocol/sdk`. Callers speak pane ids
 * only; the ACP `sessionId` never leaves `AcpSession`.
 *
 * Register a binary resolver during app bootstrap before creating a session —
 * `server-core` is Electron-free by contract and cannot locate the adapter on
 * its own. A host app whose `process.execPath` is not a Node-compatible
 * runtime (`apps/server` runs under bun) also registers an exec-path resolver.
 */

export { mapSessionUpdate } from "./acp-connection";
export { AcpHost, getAcpHost, resolveMaxConcurrentAcpSpawns } from "./acp-host";
export {
	ACP_STRIPPED_HOOK_ENV_VARS,
	getAcpBinaryPath,
	getAcpExecPath,
	setAcpBinaryPathResolver,
	setAcpExecPathResolver,
	spawnAcpChildEnv,
} from "./binary-resolver";
export type { AcpErrorCode } from "./errors";
export { acpError } from "./errors";
export {
	autoApprovePermissionHandler,
	BYPASS_PERMISSIONS_MODE_ID,
	resolveModeIdForPolicy,
} from "./permission";
export type {
	AcpConfigOption,
	AcpExitInfo,
	AcpHostEvents,
	AcpPermissionOutcome,
	AcpPermissionRequest,
	AcpPromptResult,
	AcpSessionInfo,
	AcpSessionOptions,
	AcpSessionState,
	AcpSessionUpdate,
	PermissionHandler,
	PermissionPolicy,
	SpawnProcess,
} from "./types";
