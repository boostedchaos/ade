import type { ChildProcess, SpawnOptions } from "node:child_process";
import type {
	AvailableCommand,
	Cost,
	PlanEntry,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionModeState,
	ToolCall,
	ToolCallUpdate,
} from "@agentclientprotocol/sdk";

// =============================================================================
// Session updates
// =============================================================================

/**
 * Discriminated union of `session/update` notifications, one member per kind
 * observed in the Phase 0 spike (`planning/spikes/acp-phase0/FINDINGS.md`).
 *
 * Payload shapes are the adapter's own, taken from
 * `@agentclientprotocol/sdk`'s generated schema rather than hand-transcribed.
 * Any kind not listed here — including protocol kinds this phase has no
 * consumer for (`user_message_chunk`, `plan_update`, `plan_removed`) and any
 * kind a future adapter version adds — arrives as `{ kind: "unknown", raw }`
 * so a version bump cannot crash the host.
 */
export type AcpSessionUpdate =
	| { kind: "agent_message_chunk"; text: string }
	| { kind: "agent_thought_chunk"; text: string }
	| { kind: "tool_call"; toolCall: ToolCall }
	| { kind: "tool_call_update"; toolCall: ToolCallUpdate }
	| { kind: "plan"; entries: PlanEntry[] }
	| { kind: "available_commands_update"; commands: AvailableCommand[] }
	| { kind: "config_option_update"; options: AcpConfigOption[] }
	| { kind: "current_mode_update"; modeId: string }
	| {
			kind: "session_info_update";
			title: string | null;
			updatedAt: string | null;
	  }
	| { kind: "usage_update"; used: number; size: number; cost: Cost | null }
	| { kind: "unknown"; raw: unknown };

// =============================================================================
// Config options
// =============================================================================

/**
 * A session config option, normalized from the adapter's `SessionConfigOption`.
 *
 * Boolean options are normalized to a two-value select (`"true"` / `"false"`)
 * so one string-valued `setConfigOption` signature covers both kinds and both
 * stay locally validatable.
 */
export interface AcpConfigOption {
	id: string;
	/** Human-readable label the adapter supplies for the control. */
	name: string;
	/** Optional detail; the control bar renders it as a tooltip. */
	description?: string;
	/**
	 * Adapter's semantic category (`"mode"`, `"model"`, `"thought_level"`, …).
	 * UX only, and optional — the protocol forbids depending on it for
	 * correctness, so a consumer must handle a missing or unknown value.
	 */
	category?: string;
	/** Declared legal values, from `session/new`. Empty/absent = free-form. */
	values?: { id: string; label?: string; description?: string }[];
	currentValue?: string;
}

// =============================================================================
// Permissions
// =============================================================================

export type PermissionPolicy = "auto-approve" | "prompt";

export type AcpPermissionRequest = RequestPermissionRequest;
export type AcpPermissionOutcome = RequestPermissionResponse["outcome"];

export type PermissionHandler = (
	req: AcpPermissionRequest,
) => Promise<AcpPermissionOutcome>;

// =============================================================================
// Session options and info
// =============================================================================

/** Same shape as `terminal-host/session.ts`'s SpawnProcess (the test seam). */
export type SpawnProcess = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => ChildProcess;

export interface AcpSessionOptions {
	paneId: string;
	/** Workspace root. Also the `fs/*` sandbox root. */
	cwd: string;
	/** Defaults to `"auto-approve"`. */
	permissionPolicy?: PermissionPolicy;
	/** Test seam; defaults to `node:child_process`'s `spawn`. */
	spawnProcess?: SpawnProcess;
	env?: Record<string, string>;
}

export type AcpSessionState =
	| "starting"
	| "ready"
	| "prompting"
	| "terminating"
	| "dead";

export interface AcpPromptResult {
	/** From the `session/prompt` response. */
	stopReason: string;
}

export interface AcpSessionInfo {
	paneId: string;
	acpSessionId: string;
	state: AcpSessionState;
	/** As returned by `session/new`. */
	modes: SessionModeState | null;
	/**
	 * Cached config state, not a live read — the adapter accepts illegal values
	 * silently, and `config_option_update` does not arrive during a normal
	 * prompt turn (Phase 0 findings).
	 */
	configOptions: AcpConfigOption[];
}

// =============================================================================
// Events
// =============================================================================

export interface AcpExitInfo {
	code: number | null;
	signal: string | null;
	/** True when the exit followed our own teardown ladder. */
	expected: boolean;
}

/**
 * Per-pane namespaced events, mirroring `daemon-manager.ts` /
 * `terminal-host/client.ts`.
 */
export interface AcpHostEvents {
	[key: `update:${string}`]: (update: AcpSessionUpdate) => void;
	[key: `exit:${string}`]: (info: AcpExitInfo) => void;
	[key: `error:${string}`]: (err: Error) => void;
}
