import { useCallback, useEffect, useRef, useState } from "react";
import type { MosaicBranch } from "react-mosaic-component";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { BasePaneWindow, PaneToolbarActions } from "../components";
import { AcpComposer } from "./AcpComposer";
import { AcpControlBar } from "./AcpControlBar";
import { AcpMessageList } from "./AcpMessageList";
import { type AcpPaneLifecycle, AcpStatusLine } from "./AcpStatusLine";
import { AcpUsageMeter } from "./AcpUsageMeter";
import { useAcpCommandsStore } from "./commands";
import { useAcpControlBarStore } from "./controlBar";
import { restoreNotice, shouldResumeSession } from "./restore";
import {
	type AcpRequestOutcome,
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
 * The ACP conversation pane: prompt in; text, tool cards, thinking blocks,
 * plan and usage out.
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
	const settleRequest = useAcpTranscriptStore((s) => s.settleRequest);
	const applyControlBarEvent = useAcpControlBarStore((s) => s.apply);
	const applyCommandsEvent = useAcpCommandsStore((s) => s.apply);
	const seedCommands = useAcpCommandsStore((s) => s.seed);
	const seedControlBar = useAcpControlBarStore((s) => s.seed);
	const controlBarMounted = useAcpControlBarStore((s) => s.mounted);
	const setAcpSessionId = useTabsStore((s) => s.setAcpSessionId);
	const { onPromptSent, onRequestAnswered, onEvent } = useAcpPaneStatus(paneId);

	const [lifecycle, setLifecycle] = useState<AcpPaneLifecycle>("starting");
	const [error, setError] = useState<string | null>(null);
	const [isBusy, setIsBusy] = useState(false);
	/** The one-line "restored previous session" strip, until dismissed (B1). */
	const [restoreMessage, setRestoreMessage] = useState<string | null>(null);

	// `mutate` destructured at the call site, not the mutation object: react-query
	// returns a NEW object every render, so a memoized callback closing over the
	// object would be rebuilt on every render.
	const { mutate: ensureSessionMutate } =
		electronTrpc.acp.ensureSession.useMutation();
	const promptMutation = electronTrpc.acp.prompt.useMutation();
	const cancelMutation = electronTrpc.acp.cancel.useMutation();
	const { mutate: readConfigMutate } =
		electronTrpc.acp.readConfig.useMutation();
	const { mutate: answerPermissionMutate } =
		electronTrpc.acp.answerPermission.useMutation();
	const { mutate: answerElicitationMutate } =
		electronTrpc.acp.answerElicitation.useMutation();

	// Ref, not state: the subscription callback must see the latest handlers
	// without re-subscribing (a re-subscribe drops events mid-stream).
	const handlersRef = useRef({
		applyEvent,
		applyControlBarEvent,
		applyCommandsEvent,
		onEvent,
	});
	handlersRef.current = {
		applyEvent,
		applyControlBarEvent,
		applyCommandsEvent,
		onEvent,
	};

	const startSession = useCallback(() => {
		setLifecycle("starting");
		setError(null);
		setRestoreMessage(null);

		// Read from the stores rather than from a subscribed value: this runs on
		// mount and from the "New session" button, and a stale closure over
		// either one would ask to replay a conversation that is already on
		// screen. The guard is what stops a mosaic remount double-replaying (B1).
		const storedSessionId =
			useTabsStore.getState().panes[paneId]?.acp?.acpSessionId;
		const resumeSessionId = shouldResumeSession({
			storedSessionId,
			transcriptEntryCount: useAcpTranscriptStore.getState().get(paneId).entries
				.length,
		})
			? (storedSessionId ?? null)
			: null;

		ensureSessionMutate(
			{ paneId, cwd, ...(resumeSessionId ? { resumeSessionId } : {}) },
			{
				onSuccess: (info) => {
					setLifecycle("ready");
					setRestoreMessage(
						restoreNotice({
							requestedSessionId: resumeSessionId,
							restored: info.restored,
						}),
					);
					// The id of the session that is actually live now — which is a NEW
					// one whenever the restore fell back, so the next mount does not
					// ask for the dead one again.
					setAcpSessionId(paneId, info.acpSessionId);
					// The cached list first, so the bar is populated immediately, then
					// a wire read-back: a session this pane is re-attaching to may have
					// been reconfigured since the cache was last touched.
					seedControlBar(paneId, info.configOptions, info.configSeq);
					// `session/new` never returns commands, so a pane that mounts after
					// the notification fired has only this cache to learn them from.
					// It applies to an EMPTY list only: an event already received must
					// win over a snapshot read before it (D2).
					seedCommands(paneId, info.availableCommands);
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
		seedCommands,
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
				handlersRef.current.applyCommandsEvent(paneId, event);
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

	/**
	 * Settle the card, ring the status, then put the answer on the wire.
	 *
	 * Optimistic on purpose: the buttons have to stop being clickable on the
	 * click, not a round trip later. `acp-request-not-found` — the ordinary
	 * shape of a double-click and of an answer that lost a race with a cancel —
	 * corrects the card rather than raising an error, which is what the
	 * `unavailable` outcome exists for.
	 */
	const settleAndSend = useCallback(
		(
			requestId: string,
			optimistic: AcpRequestOutcome,
			send: (onError: (error: { message: string }) => void) => void,
		) => {
			settleRequest(paneId, requestId, optimistic);
			onRequestAnswered();
			send((mutationError) =>
				settleRequest(paneId, requestId, {
					kind: "unavailable",
					reason: mutationError.message,
				}),
			);
		},
		[paneId, settleRequest, onRequestAnswered],
	);

	const handleAnswerPermission = useCallback(
		(requestId: string, optionId: string, label: string) => {
			settleAndSend(
				requestId,
				{ kind: "answered", summary: label },
				(onError) =>
					answerPermissionMutate({ paneId, requestId, optionId }, { onError }),
			);
		},
		[paneId, settleAndSend, answerPermissionMutate],
	);

	const handleAcceptElicitation = useCallback(
		(
			requestId: string,
			content: Record<string, string | string[]>,
			summary: string,
		) => {
			settleAndSend(
				requestId,
				// An accept with nothing in it is still an accept the agent asked
				// for; the summary is what the CARD shows, and it must not claim a
				// choice that was not made.
				{ kind: "answered", summary: summary || "(no answer given)" },
				(onError) =>
					answerElicitationMutate(
						{ paneId, requestId, answer: { action: "accept", content } },
						{ onError },
					),
			);
		},
		[paneId, settleAndSend, answerElicitationMutate],
	);

	const handleDeclineElicitation = useCallback(
		(requestId: string) => {
			settleAndSend(requestId, { kind: "declined" }, (onError) =>
				answerElicitationMutate(
					{ paneId, requestId, answer: { action: "decline" } },
					{ onError },
				),
			);
		},
		[paneId, settleAndSend, answerElicitationMutate],
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
				<div className="flex h-full w-full items-center justify-between gap-2">
					<AcpControlBar
						disabled={lifecycle === "starting" || lifecycle === "dead"}
						paneId={paneId}
					/>
					{/* Grouped so the meter sits beside the actions rather than being
					    spread to the middle by `justify-between`. */}
					<div className="flex shrink-0 items-center gap-2">
						{transcript.usage && (
							<AcpUsageMeter
								lastCost={transcript.lastCost}
								usage={transcript.usage}
							/>
						)}
						<PaneToolbarActions
							splitOrientation={handlers.splitOrientation}
							onSplitPane={handlers.onSplitPane}
							onClosePane={handlers.onClosePane}
							closeHotkeyId="CLOSE_TERMINAL"
						/>
					</div>
				</div>
			)}
		>
			<div className="flex h-full w-full flex-col">
				{restoreMessage && (
					<AcpRestoreStrip
						message={restoreMessage}
						onDismiss={() => setRestoreMessage(null)}
					/>
				)}
				<div className="min-h-0 flex-1">
					<AcpMessageList
						entries={transcript.entries}
						isStreaming={lifecycle === "streaming"}
						onAcceptElicitation={handleAcceptElicitation}
						onAnswerPermission={handleAnswerPermission}
						onDeclineElicitation={handleDeclineElicitation}
						plan={transcript.plan}
					/>
				</div>
				<AcpStatusLine
					lifecycle={lifecycle}
					error={error}
					onNewSession={startSession}
				/>
				<AcpComposer
					paneId={paneId}
					isBusy={isBusy}
					canSend={lifecycle === "ready" || lifecycle === "streaming"}
					lifecycle={lifecycle}
					onSend={handleSend}
					onCancel={handleCancel}
				/>
			</div>
		</BasePaneWindow>
	);
}

/**
 * The restore result, inline and dismissable (B1).
 *
 * Inline rather than the terminal's `RestoredModeOverlay`: this is a fact
 * about the conversation below it, and an overlay would cover the very
 * transcript it is describing.
 */
function AcpRestoreStrip({
	message,
	onDismiss,
}: {
	message: string;
	onDismiss: () => void;
}) {
	return (
		<div className="flex min-h-6 items-center gap-2 border-border/60 border-b bg-muted/30 px-3 py-1 text-muted-foreground text-xs">
			<span className="min-w-0 flex-1 truncate">{message}</span>
			<button
				className="shrink-0 rounded px-1 hover:bg-accent hover:text-foreground"
				onClick={onDismiss}
				type="button"
			>
				Dismiss
			</button>
		</div>
	);
}
