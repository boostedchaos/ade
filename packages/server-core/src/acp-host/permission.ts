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
 * Which session mode a policy needs.
 *
 * `"auto-approve"` picks the bypass mode explicitly rather than trusting the
 * adapter default to stay put. `"prompt"` (Phase 2) picks the first mode that
 * is not the bypass mode, so `session/request_permission` actually fires.
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
