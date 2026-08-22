import type { SessionModeState } from "@agentclientprotocol/sdk";
import type {
	AcpPermissionOutcome,
	AcpPermissionRequest,
	PermissionHandler,
	PermissionPolicy,
} from "./types";

const DEBUG_ACP = process.env.SUPERSET_ACP_DEBUG === "1";

/**
 * The adapter's default permission mode. Phase 0 confirmed it never consults
 * `canUseTool` while in this mode, which is why the policy has to move the
 * MODE and not just the callback.
 */
export const BYPASS_PERMISSIONS_MODE_ID = "bypassPermissions";

/**
 * The mode that actually asks the user, named by id (AL1).
 *
 * "The first mode that is not bypass" was the original rule and it is now
 * wrong: `claude-agent-acp` 0.63.0 leads `availableModes` with `auto`, a model
 * classifier that decides on the user's behalf and raises no
 * `session/request_permission` at all. Under a positional rule the prompting
 * policy silently stops prompting — and an agent that never asks looks exactly
 * like an agent with nothing to ask about. Position is the adapter's to
 * reorder; the id is what carries the meaning.
 */
const PROMPTING_MODE_ID = "default";

/**
 * Which session mode a policy needs.
 *
 * `"auto-approve"` picks the bypass mode explicitly rather than trusting the
 * adapter default to stay put. `"prompt"` (Phase 2) picks `"default"` by id,
 * falling back to the first non-bypass mode only when no such id is offered —
 * the id is a convention rather than a protocol guarantee, and a renamed
 * prompting mode should still beat leaving the session on bypass.
 *
 * Returns `null` when the `session/new` response offered no usable mode; the
 * caller then leaves the mode alone rather than guessing an id.
 */
export function resolveModeIdForPolicy(
	policy: PermissionPolicy,
	modes: SessionModeState | null | undefined,
): string | null {
	const available = modes?.availableModes ?? [];
	if (policy === "auto-approve") {
		const bypass = available.find(
			(mode) => mode.id === BYPASS_PERMISSIONS_MODE_ID,
		);
		return bypass?.id ?? null;
	}

	const byId = available.find((mode) => mode.id === PROMPTING_MODE_ID);
	if (byId) return byId.id;
	const prompting = available.find(
		(mode) => mode.id !== BYPASS_PERMISSIONS_MODE_ID,
	);
	return prompting?.id ?? null;
}

/**
 * Approves every request.
 *
 * Wired in Phase 1 regardless of policy: in bypass mode the adapter should
 * never call it, and if it ever does, the behavior still matches the policy.
 * A prompting handler plugs into the same seam in Phase 2 — but the seam alone
 * is not enough, the mode has to move too (see `resolveModeIdForPolicy`).
 */
export const autoApprovePermissionHandler: PermissionHandler = async (
	req: AcpPermissionRequest,
): Promise<AcpPermissionOutcome> => {
	const allow =
		req.options.find((option) => option.kind.startsWith("allow")) ??
		req.options[0];

	if (!allow) {
		console.warn(
			"[AcpPermission] requestPermission carried no options; cancelling",
		);
		return { outcome: "cancelled" };
	}

	if (DEBUG_ACP) {
		console.log(
			`[AcpPermission] auto-approving ${req.toolCall.title ?? req.toolCall.toolCallId} via option ${allow.optionId}`,
		);
	}

	return { outcome: "selected", optionId: allow.optionId };
};
