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
 * `"permission"` is reachable from Phase 6 on: it means the agent is blocked
 * on the user, which only the `"prompt"` policy (A4) and elicitation (A5) can
 * produce. Under the default auto-approve policy nothing emits those events
 * and the status is unreachable exactly as it was in Phase 2.
 */
export function acpStatusForEvent(event: AcpPaneEvent): PaneStatus | null {
	switch (event.type) {
		case "turn_end":
			// "review" — the existing `acknowledgedStatus` machinery downgrades it
			// to idle as soon as the user looks at the pane.
			return "review";
		case "turn_error":
			// "review", NOT "idle" (A6): a turn that failed needs the user, and
			// idle makes a failed turn look like a finished one — the pane goes
			// quiet and Mission Control never rings.
			return "review";
		case "permission_request":
		case "elicitation_request":
			// The highest-priority status there is, and the one the whole
			// permission flow exists for: nothing progresses until a human answers.
			return "permission";
		case "session_exit":
		case "session_error":
			return "idle";
		case "events_dropped":
			// Bookkeeping about the stream, not about the agent.
			return null;
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

/**
 * Status for the moment the user answers a permission or elicitation request.
 *
 * Back to "working", because that is what the agent goes back to doing — and
 * the answer is the only signal that it did. The next event that would move
 * the status is the turn ending, which may be a long way off.
 */
export const ACP_STATUS_ON_ANSWER: PaneStatus = "working";

export function useAcpPaneStatus(paneId: string): {
	onPromptSent: () => void;
	onRequestAnswered: () => void;
	onEvent: (event: AcpPaneEvent) => void;
} {
	const setPaneStatus = useTabsStore((s) => s.setPaneStatus);

	const onPromptSent = useCallback(() => {
		setPaneStatus(paneId, ACP_STATUS_ON_PROMPT);
	}, [paneId, setPaneStatus]);

	const onRequestAnswered = useCallback(() => {
		setPaneStatus(paneId, ACP_STATUS_ON_ANSWER);
	}, [paneId, setPaneStatus]);

	const onEvent = useCallback(
		(event: AcpPaneEvent) => {
			const status = acpStatusForEvent(event);
			if (status) setPaneStatus(paneId, status);
		},
		[paneId, setPaneStatus],
	);

	return { onPromptSent, onRequestAnswered, onEvent };
}
