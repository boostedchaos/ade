import { electronTrpcClient } from "../../../lib/trpc-client";

/**
 * Sibling of `killTerminalForPane` — same shape, same reasons.
 *
 * Uses the standalone tRPC client so the store (a plain zustand module) can
 * call it without React hooks, and is fire-and-forget: a pane is closing, and
 * nothing useful can be done with a failure except say so. Phase 1's
 * `disposeSession` is idempotent and resolves for a pane it has never heard
 * of, so double-dispose is harmless.
 */
export const disposeAcpForPane = (paneId: string): void => {
	electronTrpcClient.acp.dispose.mutate({ paneId }).catch((error) => {
		console.warn(`Failed to dispose ACP session for pane ${paneId}:`, error);
	});
};
