/**
 * Restore-on-mount: whether to ask for the stored session back, and what to
 * tell the user about what came back (B1).
 *
 * Pure, and separate from `AcpPane` for the same reason `transcript.ts` is:
 * the double-replay guard is the part that can silently duplicate a whole
 * conversation, and it must be testable without Electron, IPC or an adapter.
 */

/**
 * Ask for `session/load` only when this pane's transcript is EMPTY.
 *
 * A mosaic remount (every split, every drag) re-runs the mount effect against
 * a transcript store that survives it, and `AcpPane` is deliberately lazy —
 * `ensureSession` is idempotent for a LIVE session, but a pane whose session
 * died and is being restarted would replay the whole history into entries that
 * are already there. Emptiness is the only signal that distinguishes the two,
 * because the reducer cannot tell a replayed frame from a live one (it carries
 * no marker, by protocol design).
 */
export function shouldResumeSession(input: {
	/** The persisted `AcpPaneState.acpSessionId`, if this pane ever had one. */
	storedSessionId: string | undefined;
	/** How many entries the pane's transcript store already holds. */
	transcriptEntryCount: number;
}): boolean {
	if (!input.storedSessionId) return false;
	return input.transcriptEntryCount === 0;
}

/**
 * The one-line strip shown after a session starts, or null for nothing to say.
 *
 * "Fresh with no stored id" is the ordinary first-ever start and says nothing.
 * "Fresh WITH a stored id" is the honest failure case the design's rule exists
 * for: the agent no longer knows that conversation, and a pane that quietly
 * started an empty one would look identical to a successful restore.
 */
export function restoreNotice(input: {
	/** What was asked for — null when no restore was attempted. */
	requestedSessionId: string | null;
	/** What `ensureSession` reported. */
	restored: "replayed" | "fresh";
}): string | null {
	if (input.restored === "replayed") return "Restored previous session.";
	if (input.requestedSessionId)
		return "Previous session could not be restored — new session started.";
	return null;
}
