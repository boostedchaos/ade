/**
 * The status line's one decision: whether "New session" asks before it throws
 * a conversation away.
 *
 * Same split as `commands.ts` and `controlBar.ts` — the rule is DOM-free, so
 * the destructive-action guard is testable without React. That matters more
 * here than elsewhere: the failure this protects against is silent and
 * unrecoverable (the agent forgets the conversation; the transcript is gone).
 */

import type { AcpPaneLifecycle } from "./AcpStatusLine";

export const NEW_SESSION_LABEL = "New session";
/** Deliberately a question: the same button, now armed, is the confirmation. */
export const NEW_SESSION_CONFIRM_LABEL = "Discard & restart?";

/**
 * Ask first only when there is something to lose.
 *
 * A DEAD session has already ended — restarting it is the recovery path the
 * button was originally built for (it was `lifecycle === "dead"`-only until
 * 2026-08-22), and putting a confirm in front of it would make the one case
 * that has no downside the slowest one.
 *
 * Everything else is gated on the TRANSCRIPT, not on the lifecycle. A live
 * session holding nothing — a pane just opened, or one already restarted — is
 * as safe to replace as a dead one, and prompting there trains the confirm to
 * be dismissed unread, which is how a guard stops guarding.
 */
export function restartNeedsConfirm(input: {
	lifecycle: AcpPaneLifecycle;
	/** Entries in this pane's transcript store. */
	transcriptEntryCount: number;
}): boolean {
	if (input.lifecycle === "dead") return false;
	return input.transcriptEntryCount > 0;
}

/** The label the button renders, given whether it is currently armed. */
export function newSessionLabel(armed: boolean): string {
	return armed ? NEW_SESSION_CONFIRM_LABEL : NEW_SESSION_LABEL;
}
