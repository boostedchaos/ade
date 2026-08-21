import type { AcpPaneEvent } from "lib/trpc/routers/acp";
import { useCallback } from "react";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { PaneStatus } from "shared/tabs-types";

/**
 * D5: for an ACP pane, this hook is the SOLE writer of `setPaneStatus`.
 *
 * Status is derived in-band, from the same event stream the transcript is
 * built from, rather than from the HTTP hooks path that terminal panes use.
 * The two are disjoint by construction — `spawnAcpChildEnv` strips the hook
 * identity vars (`ACP_STRIPPED_HOOK_ENV_VARS`), so a CLI running under the
 * adapter cannot report to the hooks server under any pane id — and that
 * disjointness is asserted in `packages/server-core/src/acp-host/spawn-env.test.ts`
 * rather than assumed.
 *
 * `"permission"` is deliberately unreachable here: it means a genuine
 * permission block, which Phase 2's auto-approve policy cannot produce. It
 * belongs to the future `"prompt"` policy.
 */
export function acpStatusForEvent(event: AcpPaneEvent): PaneStatus | null {
	switch (event.type) {
		case "turn_end":
			// "review" — the existing `acknowledgedStatus` machinery downgrades it
			// to idle as soon as the user looks at the pane.
			return "review";
		case "turn_error":
		case "session_exit":
		case "session_error":
			return "idle";
		case "update":
			// Streaming content does not move the status: `prompt sent → working`
			// already covers the whole turn, and re-writing "working" on every
			// chunk would be a store write per token.
			return null;
		default:
			return null;
	}
}

/** Status for the moment the user presses send. */
export const ACP_STATUS_ON_PROMPT: PaneStatus = "working";

export function useAcpPaneStatus(paneId: string): {
	onPromptSent: () => void;
	onEvent: (event: AcpPaneEvent) => void;
} {
	const setPaneStatus = useTabsStore((s) => s.setPaneStatus);

	const onPromptSent = useCallback(() => {
		setPaneStatus(paneId, ACP_STATUS_ON_PROMPT);
	}, [paneId, setPaneStatus]);

	const onEvent = useCallback(
		(event: AcpPaneEvent) => {
			const status = acpStatusForEvent(event);
			if (status) setPaneStatus(paneId, status);
		},
		[paneId, setPaneStatus],
	);

	return { onPromptSent, onEvent };
}
