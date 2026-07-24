import { useRef, useState } from "react";
import { useCreateOrAttachWithTheme } from "renderer/hooks/useCreateOrAttachWithTheme";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { terminalClientId } from "renderer/lib/terminal-client-id";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import type {
	TerminalClearScrollbackMutate,
	TerminalDetachMutate,
	TerminalResizeMutate,
	TerminalWriteMutate,
} from "../types";
import { markLatencyInput } from "./latency-tracker";

export interface UseTerminalConnectionOptions {
	workspaceId: string;
	/**
	 * Multi-device attach policy (issue #7): true while this client is a
	 * read-only mirror of the pane (another device holds the writer lease).
	 * Local input is suppressed here; the server drops it too.
	 */
	readOnlyRef?: React.MutableRefObject<boolean>;
}

/**
 * Hook to manage terminal connection state and mutations.
 *
 * Encapsulates:
 * - createOrAttach mutation (for lifecycle callbacks)
 * - imperative tRPC calls for write/resize/detach/clearScrollback hot paths
 * - Stable refs to mutation functions (to avoid re-renders)
 * - Connection error state
 * - Workspace CWD query
 *
 * NOTE: Stream subscription is intentionally NOT included here because it needs
 * direct access to xterm refs for event handling. Keep that in the component.
 */
export function useTerminalConnection({
	workspaceId,
	readOnlyRef,
}: UseTerminalConnectionOptions) {
	const [connectionError, setConnectionError] = useState<string | null>(null);

	// tRPC mutations
	const createOrAttachMutation = useCreateOrAttachWithTheme();

	// Query for workspace cwd
	const { data: workspaceCwd } =
		electronTrpc.terminal.getWorkspaceCwd.useQuery(workspaceId);

	// Stable refs - these don't change identity on re-render.
	// All calls carry terminalClientId so ade-server can enforce the
	// writer lease (issue #7); the desktop router ignores it.
	type CreateOrAttachFn = typeof createOrAttachMutation.mutate;
	const createOrAttachRef = useRef<CreateOrAttachFn>((input, options) =>
		createOrAttachMutation.mutate(
			{ ...input, clientId: terminalClientId },
			options,
		),
	);
	// Use imperative client calls for write/resize/detach/clear to avoid
	// mutation-observer re-renders on every keystroke.
	const writeRef = useRef<TerminalWriteMutate>((input, callbacks) => {
		// Read-only mirror: swallow local input entirely (the server would
		// drop it anyway; skipping the round-trip keeps mirrors silent).
		if (readOnlyRef?.current) {
			callbacks?.onSettled?.();
			return;
		}
		// Latency metric (issue #59): stamp keystroke-sized writes. After the
		// mirror guard on purpose — read-only panes must produce no samples.
		markLatencyInput(input.paneId, input.data);
		electronTrpcClient.terminal.write
			.mutate({ ...input, clientId: terminalClientId })
			.then(() => {
				callbacks?.onSuccess?.();
			})
			.catch((error) => {
				callbacks?.onError?.({
					message: error instanceof Error ? error.message : "Write failed",
				});
			})
			.finally(() => {
				callbacks?.onSettled?.();
			});
	});
	const resizeRef = useRef<TerminalResizeMutate>((input) => {
		electronTrpcClient.terminal.resize
			.mutate({ ...input, clientId: terminalClientId })
			.catch((error) => {
				console.warn("[Terminal] Failed to resize terminal:", error);
			});
	});
	const detachRef = useRef<TerminalDetachMutate>((input) => {
		electronTrpcClient.terminal.detach
			.mutate({ ...input, clientId: terminalClientId })
			.catch((error) => {
				console.warn("[Terminal] Failed to detach terminal:", error);
			});
	});
	const clearScrollbackRef = useRef<TerminalClearScrollbackMutate>((input) => {
		electronTrpcClient.terminal.clearScrollback.mutate(input).catch((error) => {
			console.warn("[Terminal] Failed to clear scrollback:", error);
		});
	});

	// Keep refs up to date (re-wrap so the latest mutate is used and the
	// attach-policy clientId is always attached).
	createOrAttachRef.current = (input, options) =>
		createOrAttachMutation.mutate(
			{ ...input, clientId: terminalClientId },
			options,
		);

	return {
		// Connection error state
		connectionError,
		setConnectionError,

		// Workspace CWD from query
		workspaceCwd,

		// Stable refs to mutation functions (use these in effects/callbacks)
		refs: {
			createOrAttach: createOrAttachRef,
			write: writeRef,
			resize: resizeRef,
			detach: detachRef,
			clearScrollback: clearScrollbackRef,
		},
	};
}
