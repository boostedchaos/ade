import { useCallback, useEffect, useRef, useState } from "react";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { BasePaneWindow, PaneToolbarActions } from "../components";
import { AcpComposer } from "./AcpComposer";
import { AcpControlBar } from "./AcpControlBar";
import { AcpMessageList } from "./AcpMessageList";
import { type AcpPaneLifecycle, AcpStatusLine } from "./AcpStatusLine";
import { useAcpControlBarStore } from "./controlBar";
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
	const applyControlBarEvent = useAcpControlBarStore((s) => s.apply);
	const seedControlBar = useAcpControlBarStore((s) => s.seed);
	const controlBarMounted = useAcpControlBarStore((s) => s.mounted);
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
	const { mutate: readConfigMutate } =
		electronTrpc.acp.readConfig.useMutation();

	// Ref, not state: the subscription callback must see the latest handlers
	// without re-subscribing (a re-subscribe drops events mid-stream).
	const handlersRef = useRef({ applyEvent, applyControlBarEvent, onEvent });
	handlersRef.current = { applyEvent, applyControlBarEvent, onEvent };

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
					// The cached list first, so the bar is populated immediately, then
					// a wire read-back: a session this pane is re-attaching to may have
					// been reconfigured since the cache was last touched.
					seedControlBar(paneId, info.configOptions, info.configSeq);
					readConfigMutate(
						{ paneId },
						{
							onSuccess: (result) =>
								seedControlBar(paneId, result.configOptions, result.seq),
						},
					);
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
	}, [
		paneId,
		cwd,
		setAcpSessionId,
		seedControlBar,
		readConfigMutate,
		ensureSessionMutate,
	]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only, by design (D6)
	useEffect(() => {
		// A write that was in flight when this pane last unmounted has no live
		// mutation observer left to settle it (TanStack Query v5 drops per-call
		// callbacks on unmount), and a stranded `pending` disables the whole bar
		// with no spinner and no error to explain it (A3).
		controlBarMounted(paneId);
		startSession();
	}, []);

	electronTrpc.acp.events.useSubscription(
		{ paneId },
		{
			onData: (event) => {
				handlersRef.current.applyEvent(paneId, event);
				handlersRef.current.applyControlBarEvent(paneId, event);
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
					<AcpControlBar
						disabled={lifecycle === "starting" || lifecycle === "dead"}
						paneId={paneId}
					/>
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
