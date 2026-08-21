import { useCallback, useEffect, useRef, useState } from "react";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { BasePaneWindow, PaneToolbarActions } from "../components";
import { AcpComposer } from "./AcpComposer";
import { AcpMessageList } from "./AcpMessageList";
import { type AcpPaneLifecycle, AcpStatusLine } from "./AcpStatusLine";
import {
	type AcpTranscript,
	emptyTranscript,
	useAcpTranscriptStore,
} from "./transcript";
import { useAcpPaneStatus } from "./useAcpPaneStatus";

/**
 * Stable identity: a selector returning a fresh object every render would make
 * the component re-render forever.
 */
const EMPTY_TRANSCRIPT: AcpTranscript = emptyTranscript();

interface AcpPaneProps {
	paneId: string;
	path: MosaicBranch[];
	tabId: string;
	/** Workspace root the session runs in (the agent's worktree). */
	cwd: string;
	splitPaneAuto: (
		tabId: string,
		sourcePaneId: string,
		dimensions: { width: number; height: number },
		path?: MosaicBranch[],
	) => void;
	removePane: (paneId: string) => void;
	setFocusedPane: (tabId: string, paneId: string) => void;
}

/**
 * The ACP conversation pane: text in, text out.
 *
 * Session creation is LAZY — on first mount, not on pane creation — because a
 * pane restored into a background tab nobody opens should not spawn an adapter
 * child. Mount is the demand signal. The call is idempotent end to end, so
 * React StrictMode's double mount and mosaic re-mounts are absorbed.
 */
export function AcpPane({
	paneId,
	path,
	tabId,
	cwd,
	splitPaneAuto,
	removePane,
	setFocusedPane,
}: AcpPaneProps) {
	const transcript = useAcpTranscriptStore(
		(s) => s.byPane[paneId] ?? EMPTY_TRANSCRIPT,
	);
	const applyEvent = useAcpTranscriptStore((s) => s.apply);
	const promptSent = useAcpTranscriptStore((s) => s.promptSent);
	const setAcpSessionId = useTabsStore((s) => s.setAcpSessionId);
	const { onPromptSent, onEvent } = useAcpPaneStatus(paneId);

	const [lifecycle, setLifecycle] = useState<AcpPaneLifecycle>("starting");
	const [error, setError] = useState<string | null>(null);
	const [isBusy, setIsBusy] = useState(false);

	// `mutate` destructured at the call site, not the mutation object: react-query
	// returns a NEW object every render, so a memoized callback closing over the
	// object would be rebuilt on every render.
	const { mutate: ensureSessionMutate } =
		electronTrpc.acp.ensureSession.useMutation();
	const promptMutation = electronTrpc.acp.prompt.useMutation();
	const cancelMutation = electronTrpc.acp.cancel.useMutation();

	// Ref, not state: the subscription callback must see the latest handlers
	// without re-subscribing (a re-subscribe drops events mid-stream).
	const handlersRef = useRef({ applyEvent, onEvent });
	handlersRef.current = { applyEvent, onEvent };

	const startSession = useCallback(() => {
		setLifecycle("starting");
		setError(null);
		ensureSessionMutate(
			{ paneId, cwd },
			{
				onSuccess: (info) => {
					setLifecycle("ready");
					// Written for Phase 6's resume. Phase 2 never reads it back.
					setAcpSessionId(paneId, info.acpSessionId);
				},
				onError: (mutationError) => {
					// VERBATIM: the Phase 1 codes name their own fix, and so does
					// `acp-claude-not-found`. A pane that hides this is a pane that
					// hangs on "starting…" forever.
					setLifecycle("dead");
					setError(mutationError.message);
				},
			},
		);
	}, [paneId, cwd, setAcpSessionId, ensureSessionMutate]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only, by design (D6)
	useEffect(() => {
		startSession();
	}, []);

	electronTrpc.acp.events.useSubscription(
		{ paneId },
		{
			onData: (event) => {
				handlersRef.current.applyEvent(paneId, event);
				handlersRef.current.onEvent(event);
				switch (event.type) {
					case "update":
						setLifecycle((current) =>
							current === "dead" ? current : "streaming",
						);
						break;
					case "turn_end":
						setIsBusy(false);
						setLifecycle("ready");
						break;
					case "turn_error":
						setIsBusy(false);
						setLifecycle("ready");
						setError(event.message);
						break;
					case "session_exit":
						setIsBusy(false);
						setLifecycle("dead");
						setError(
							event.expected
								? null
								: `Session ended — exit code ${event.code ?? "unknown"}`,
						);
						break;
					case "session_error":
						setIsBusy(false);
						setLifecycle("dead");
						setError(event.message);
						break;
				}
			},
			onError: (subscriptionError) => {
				setError(
					subscriptionError instanceof Error
						? subscriptionError.message
						: String(subscriptionError),
				);
			},
		},
	);

	const handleSend = (text: string) => {
		promptSent(paneId, text);
		onPromptSent();
		setIsBusy(true);
		setError(null);
		setLifecycle("streaming");
		promptMutation.mutate(
			{ paneId, text },
			{
				// The turn boundary arrives IN THE STREAM (`turn_end` /
				// `turn_error`), not here: settling this mutation and reading the
				// event stream are two IPC channels, and only one of them is
				// ordered against the updates.
				onError: () => setIsBusy(false),
			},
		);
	};

	const handleCancel = () => {
		cancelMutation.mutate({ paneId });
	};

	return (
		<BasePaneWindow
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center justify-between">
					<div className="flex h-full items-center px-2">
						<span className="text-muted-foreground text-xs">ACP Session</span>
					</div>
					<PaneToolbarActions
						splitOrientation={handlers.splitOrientation}
						onSplitPane={handlers.onSplitPane}
						onClosePane={handlers.onClosePane}
						closeHotkeyId="CLOSE_TERMINAL"
					/>
				</div>
			)}
		>
			<div className="flex h-full w-full flex-col">
				<div className="min-h-0 flex-1">
					<AcpMessageList
						entries={transcript.entries}
						isStreaming={lifecycle === "streaming"}
					/>
				</div>
				<AcpStatusLine
					lifecycle={lifecycle}
					error={error}
					onNewSession={startSession}
				/>
				<AcpComposer
					isBusy={isBusy}
					canSend={lifecycle === "ready" || lifecycle === "streaming"}
					onSend={handleSend}
					onCancel={handleCancel}
				/>
			</div>
		</BasePaneWindow>
	);
}
