import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "renderer/hooks/useIsMobile";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { isWebShell } from "renderer/lib/is-web-shell";
import { terminalClientId } from "renderer/lib/terminal-client-id";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useTabsStore } from "renderer/stores/tabs/store";
import { useTerminalTheme } from "renderer/stores/theme";
import { getTerminalProfile } from "shared/terminal-profiles";
import {
	SessionKilledOverlay,
	TerminalKeyBar,
	TerminalStatusBar,
	WaitingOnYouBar,
} from "./components";
import {
	DEFAULT_TERMINAL_FONT_FAMILY,
	DEFAULT_TERMINAL_FONT_SIZE,
} from "./config";
import { getDefaultTerminalBg, type TerminalRendererRef } from "./helpers";
import {
	useFileLinkClick,
	useTerminalColdRestore,
	useTerminalConnection,
	useTerminalCwd,
	useTerminalHotkeys,
	useTerminalLatency,
	useTerminalLifecycle,
	useTerminalModes,
	useTerminalRefs,
	useTerminalRestore,
	useTerminalStream,
} from "./hooks";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { TerminalSearch } from "./TerminalSearch";
import type {
	TerminalExitReason,
	TerminalProps,
	TerminalStreamEvent,
} from "./types";
import { shellEscapePaths } from "./utils";

const stripLeadingEmoji = (text: string) =>
	text.trim().replace(/^[\p{Emoji}\p{Symbol}]\s*/u, "");

export const Terminal = ({ paneId, tabId, workspaceId }: TerminalProps) => {
	const pane = useTabsStore((s) => s.panes[paneId]);
	const paneInitialCwd = pane?.initialCwd;
	// Agent-pane gate (issue #60): pane `status` is only ever set on
	// wrapper-launched agents (working/permission/review via useAgentHookListener;
	// the exit/keystroke fallbacks only touch panes already in
	// working/permission) and is never reset to undefined — so a plain shell
	// stays undefined and renders no chrome. Truthy for all four PaneStatus
	// values. See docs/tickets/terminal-native-feel.md (issue 3).
	const paneStatus = pane?.status;
	// Keystroke→paint latency for the status header (issue #59's hook).
	const { echoMs } = useTerminalLatency(paneId);
	const clearPaneInitialData = useTabsStore((s) => s.clearPaneInitialData);

	const { data: workspaceData } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId },
		{ staleTime: 30_000 },
	);
	const isUnnamedRef = useRef(false);
	isUnnamedRef.current = workspaceData?.isUnnamed ?? false;

	const utils = electronTrpc.useUtils();
	const updateWorkspace = electronTrpc.workspaces.update.useMutation({
		onSuccess: () => {
			utils.workspaces.getAllGrouped.invalidate();
			utils.workspaces.get.invalidate({ id: workspaceId });
		},
	});

	const renameUnnamedWorkspaceRef = useRef<(title: string) => void>(() => {});
	renameUnnamedWorkspaceRef.current = (title: string) => {
		const cleanedTitle = stripLeadingEmoji(title);
		if (isUnnamedRef.current && cleanedTitle) {
			updateWorkspace.mutate({
				id: workspaceId,
				patch: { name: cleanedTitle, preserveUnnamedStatus: true },
			});
		}
	};
	const terminalRef = useRef<HTMLDivElement>(null);
	const xtermRef = useRef<XTerm | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const searchAddonRef = useRef<SearchAddon | null>(null);
	const rendererRef = useRef<TerminalRendererRef | null>(null);
	const isExitedRef = useRef(false);
	const [exitStatus, setExitStatus] = useState<"killed" | "exited" | null>(
		null,
	);
	const wasKilledByUserRef = useRef(false);
	const pendingEventsRef = useRef<TerminalStreamEvent[]>([]);
	const commandBufferRef = useRef("");
	const tabIdRef = useRef(tabId);
	tabIdRef.current = tabId;
	const setFocusedPane = useTabsStore((s) => s.setFocusedPane);
	const setPaneName = useTabsStore((s) => s.setPaneName);
	const focusedPaneId = useTabsStore((s) => s.focusedPaneIds[tabId]);
	const globalTerminalTheme = useTerminalTheme();
	const terminalProfileId = pane?.terminalProfileId;
	const terminalTheme = (() => {
		if (terminalProfileId) {
			const profile = getTerminalProfile(terminalProfileId);
			if (profile) {
				return {
					...globalTerminalTheme,
					...profile.colors,
				};
			}
		}
		return globalTerminalTheme;
	})();

	// Multi-device attach policy (issue #7): true while another device holds
	// this pane's writer lease. Driven purely by server `mode` stream events
	// (the desktop router never emits them, so Electron never mirrors).
	const [isReadOnly, setIsReadOnly] = useState(false);
	const readOnlyRef = useRef(false);

	// Terminal connection state and mutations
	const {
		connectionError,
		setConnectionError,
		workspaceCwd,
		refs: {
			createOrAttach: createOrAttachRef,
			write: writeRef,
			resize: resizeRef,
			detach: detachRef,
			clearScrollback: clearScrollbackRef,
		},
	} = useTerminalConnection({ workspaceId, readOnlyRef });

	// Terminal CWD management
	const { updateCwdFromData } = useTerminalCwd({
		paneId,
		initialCwd: paneInitialCwd,
		workspaceCwd,
	});

	// Terminal modes tracking
	const {
		isAlternateScreenRef,
		isBracketedPasteRef,
		modeScanBufferRef,
		updateModesFromData,
		resetModes,
	} = useTerminalModes();

	// File link click handler
	const { handleFileLinkClick } = useFileLinkClick({
		workspaceId,
		workspaceCwd,
	});

	// URL click handler - opens in app browser or system browser based on setting
	const { data: openLinksInApp } =
		electronTrpc.settings.getOpenLinksInApp.useQuery();
	const openInBrowserPane = useTabsStore((s) => s.openInBrowserPane);
	const handleUrlClickRef = useRef<((url: string) => void) | undefined>(
		undefined,
	);
	handleUrlClickRef.current = openLinksInApp
		? (url: string) => openInBrowserPane(workspaceId, url)
		: undefined;

	// Refs for stream event handlers (populated after useTerminalStream)
	// These allow flushPendingEvents to call the handlers via refs
	const handleTerminalExitRef = useRef<
		(exitCode: number, xterm: XTerm, reason?: TerminalExitReason) => void
	>(() => {});
	const handleStreamErrorRef = useRef<
		(
			event: Extract<TerminalStreamEvent, { type: "error" }>,
			xterm: XTerm,
		) => void
	>(() => {});

	const {
		isFocused,
		isFocusedRef,
		initialThemeRef,
		paneInitialCwdRef,
		clearPaneInitialDataRef,
		workspaceCwdRef,
		handleFileLinkClickRef,
		setPaneNameRef,
		handleTerminalFocusRef,
		registerClearCallbackRef,
		unregisterClearCallbackRef,
		registerScrollToBottomCallbackRef,
		unregisterScrollToBottomCallbackRef,
		registerGetSelectionCallbackRef,
		unregisterGetSelectionCallbackRef,
		registerPasteCallbackRef,
		unregisterPasteCallbackRef,
	} = useTerminalRefs({
		paneId,
		tabId,
		focusedPaneId,
		terminalTheme,
		paneInitialCwd,
		clearPaneInitialData,
		workspaceCwd,
		handleFileLinkClick,
		setPaneName,
		setFocusedPane,
	});

	// Terminal restore logic
	const {
		isStreamReadyRef,
		didFirstRenderRef,
		pendingInitialStateRef,
		maybeApplyInitialState,
		flushPendingEvents,
	} = useTerminalRestore({
		paneId,
		xtermRef,
		fitAddonRef,
		pendingEventsRef,
		isAlternateScreenRef,
		isBracketedPasteRef,
		modeScanBufferRef,
		updateCwdFromData,
		updateModesFromData,
		onExitEvent: (exitCode, xterm, reason) =>
			handleTerminalExitRef.current(exitCode, xterm, reason),
		onErrorEvent: (event, xterm) => handleStreamErrorRef.current(event, xterm),
		onDisconnectEvent: (reason) =>
			setConnectionError(reason || "Connection to terminal daemon lost"),
	});

	// Cold restore handling
	const {
		isRestoredMode,
		setIsRestoredMode,
		setRestoredCwd,
		handleRetryConnection,
		handleStartShell,
	} = useTerminalColdRestore({
		paneId,
		tabId,
		workspaceId,
		xtermRef,
		fitAddonRef,
		isStreamReadyRef,
		isExitedRef,
		wasKilledByUserRef,
		isFocusedRef,
		didFirstRenderRef,
		pendingInitialStateRef,
		pendingEventsRef,
		createOrAttachRef,
		setConnectionError,
		setExitStatus,
		maybeApplyInitialState,
		flushPendingEvents,
		resetModes,
	});

	// Avoid effect re-runs: track overlay states via refs for input gating
	const isRestoredModeRef = useRef(isRestoredMode);
	isRestoredModeRef.current = isRestoredMode;
	const connectionErrorRef = useRef(connectionError);
	connectionErrorRef.current = connectionError;

	// Auto-retry connection with exponential backoff
	const retryCountRef = useRef(0);
	const MAX_RETRIES = 5;
	// How long the page must have been hidden before we assume the platform
	// (iOS Safari) may have killed the WebSocket and force a re-attach.
	const HIDDEN_REATTACH_THRESHOLD_MS = 5_000;

	// Stream handling
	const { handleTerminalExit, handleStreamError, handleStreamData } =
		useTerminalStream({
			paneId,
			xtermRef,
			isStreamReadyRef,
			isExitedRef,
			wasKilledByUserRef,
			pendingEventsRef,
			setExitStatus,
			setConnectionError,
			updateModesFromData,
			updateCwdFromData,
		});

	// Populate handler refs for flushPendingEvents to use
	handleTerminalExitRef.current = handleTerminalExit;
	handleStreamErrorRef.current = handleStreamError;

	// Stream subscription. The clientId binds this subscription as our
	// liveness signal for the writer lease on ade-server (issue #7).
	electronTrpc.terminal.stream.useSubscription(
		{ paneId, clientId: terminalClientId },
		{
			onData: (event) => {
				// Writer/mirror status — handled here, never queued/replayed.
				if (event.type === "mode") {
					readOnlyRef.current = event.readOnly;
					setIsReadOnly(event.readOnly);
					return;
				}
				if (connectionErrorRef.current && event.type === "data") {
					setConnectionError(null);
					retryCountRef.current = 0;
				}
				handleStreamData(event);
			},
			onError: (error) => {
				console.error("[Terminal] Stream subscription error:", {
					paneId,
					error: error instanceof Error ? error.message : String(error),
				});
				setConnectionError(
					error instanceof Error
						? error.message
						: "Connection to terminal lost",
				);
			},
			enabled: true,
		},
	);

	// Auto-retry when connection error is set
	useEffect(() => {
		if (!connectionError) return;
		if (isExitedRef.current) return;
		if (retryCountRef.current >= MAX_RETRIES) return;

		if (retryCountRef.current === 0) {
			xtermRef.current?.writeln(
				"\r\n\x1b[90m[Connection lost. Reconnecting...]\x1b[0m",
			);
		}

		const delay = Math.min(1000 * 2 ** retryCountRef.current, 10_000);
		retryCountRef.current++;

		const timeout = setTimeout(handleRetryConnection, delay);
		return () => clearTimeout(timeout);
	}, [connectionError, handleRetryConnection]);

	// Resubscribe/replay on visibilitychange (PHASE_3 §3 socket suspension):
	// iOS Safari kills background WebSockets, and output produced while the
	// socket was dead is lost (the daemon stream doesn't replay on subscribe).
	// When the page returns to the foreground after a real suspension, wipe
	// the buffer and re-attach — createOrAttach returns the daemon's snapshot,
	// so the terminal comes back with full history. Web shell only; the
	// desktop's sockets never suspend.
	useEffect(() => {
		if (!isWebShell()) return;
		let hiddenAt: number | null = null;
		const handleVisibilityResume = () => {
			if (document.visibilityState === "hidden") {
				hiddenAt = Date.now();
				return;
			}
			const hiddenFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
			hiddenAt = null;
			if (isExitedRef.current || isRestoredModeRef.current) return;
			// Quick tab flips with a healthy connection don't need a replay.
			if (
				hiddenFor < HIDDEN_REATTACH_THRESHOLD_MS &&
				!connectionErrorRef.current
			) {
				return;
			}
			xtermRef.current?.reset();
			retryCountRef.current = 0;
			handleRetryConnection();
		};
		document.addEventListener("visibilitychange", handleVisibilityResume);
		return () =>
			document.removeEventListener("visibilitychange", handleVisibilityResume);
	}, [handleRetryConnection]);

	// iOS keyboard focus shim (PHASE_3 §3): tapping the terminal must reliably
	// focus xterm's hidden textarea inside the touch gesture so the software
	// keyboard comes up. Skipped implicitly on desktop (no touch events).
	useEffect(() => {
		const container = terminalRef.current;
		if (!container) return;
		const handleTouchEnd = () => {
			const xterm = xtermRef.current;
			if (!xterm || xterm.hasSelection()) return;
			xterm.focus();
		};
		container.addEventListener("touchend", handleTouchEnd);
		return () => container.removeEventListener("touchend", handleTouchEnd);
	}, []);

	const { isSearchOpen, setIsSearchOpen } = useTerminalHotkeys({
		isFocused,
		xtermRef,
	});
	useEffect(() => {
		if (!isRestoredMode) return;
		handleStartShell();
	}, [isRestoredMode, handleStartShell]);
	const { xtermInstance, restartTerminal } = useTerminalLifecycle({
		paneId,
		tabIdRef,
		workspaceId,
		terminalRef,
		xtermRef,
		fitAddonRef,
		searchAddonRef,
		rendererRef,
		isExitedRef,
		wasKilledByUserRef,
		commandBufferRef,
		isFocusedRef,
		isRestoredModeRef,
		connectionErrorRef,
		initialThemeRef,
		workspaceCwdRef,
		handleFileLinkClickRef,
		handleUrlClickRef,
		paneInitialCwdRef,
		clearPaneInitialDataRef,
		setConnectionError,
		setExitStatus,
		setIsRestoredMode,
		setRestoredCwd,
		createOrAttachRef,
		writeRef,
		resizeRef,
		detachRef,
		clearScrollbackRef,
		isStreamReadyRef,
		didFirstRenderRef,
		pendingInitialStateRef,
		maybeApplyInitialState,
		flushPendingEvents,
		resetModes,
		isAlternateScreenRef,
		isBracketedPasteRef,
		setPaneNameRef,
		renameUnnamedWorkspaceRef,
		handleTerminalFocusRef,
		registerClearCallbackRef,
		unregisterClearCallbackRef,
		registerScrollToBottomCallbackRef,
		unregisterScrollToBottomCallbackRef,
		registerGetSelectionCallbackRef,
		unregisterGetSelectionCallbackRef,
		registerPasteCallbackRef,
		unregisterPasteCallbackRef,
	});

	useEffect(() => {
		const xterm = xtermRef.current;
		if (!xterm || !terminalTheme) return;
		xterm.options.theme = terminalTheme;
	}, [terminalTheme]);

	// Waiting-on-you staleness clear (issue #60): no agent hook fires when the
	// user denies a permission prompt or interrupts with Ctrl+C, so the
	// "permission" status that drives the WaitingOnYouBar would stick. xterm's
	// onData fires on real user input only (keystrokes/paste, never programmatic
	// writes), so any typed response — approve, deny, or interrupt — clears the
	// bar. Mirrors the mobile-Esc clear in handleKeyBarEscape below.
	useEffect(() => {
		if (!xtermInstance) return;
		const disposable = xtermInstance.onData(() => {
			if (useTabsStore.getState().panes[paneId]?.status === "permission") {
				useTabsStore.getState().setPaneStatus(paneId, "idle");
			}
		});
		return () => disposable.dispose();
	}, [xtermInstance, paneId]);

	const { data: fontSettings } = electronTrpc.settings.getFontSettings.useQuery(
		undefined,
		{
			staleTime: 30_000,
		},
	);

	useEffect(() => {
		const xterm = xtermRef.current;
		if (!xterm || !fontSettings) return;
		const family =
			fontSettings.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
		const size = fontSettings.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE;
		xterm.options.fontFamily = family;
		xterm.options.fontSize = size;
		fitAddonRef.current?.fit();
	}, [fontSettings]);

	const terminalBg = terminalTheme?.background ?? getDefaultTerminalBg();

	// Mobile on-screen key bar (Esc/Tab/sticky-Ctrl/arrows/Enter).
	const isMobile = useIsMobile();
	const handleKeyBarSend = useCallback(
		(data: string) => {
			if (
				isExitedRef.current ||
				isRestoredModeRef.current ||
				connectionErrorRef.current
			) {
				return;
			}
			writeRef.current({ paneId, data });
		},
		[paneId, writeRef],
	);
	// Multi-device attach policy (issue #7): explicit last-writer-wins
	// takeover from a mirrored client. The server transfers the lease and
	// flips both clients' modes via stream `mode` events.
	const handleTakeControl = useCallback(() => {
		electronTrpcClient.terminal.takeWriter
			.mutate({ paneId, clientId: terminalClientId })
			.catch((error) => {
				console.warn("[Terminal] Failed to take terminal control:", error);
			});
	}, [paneId]);

	const handleKeyBarEscape = useCallback(() => {
		const currentPane = useTabsStore.getState().panes[paneId];
		if (
			currentPane?.status === "working" ||
			currentPane?.status === "permission"
		) {
			useTabsStore.getState().setPaneStatus(paneId, "idle");
		}
	}, [paneId]);

	const handleDragOver = (event: React.DragEvent) => {
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	};

	const handleDrop = (event: React.DragEvent) => {
		event.preventDefault();
		const files = Array.from(event.dataTransfer.files);
		let text: string;
		if (files.length > 0) {
			// Native file drop (from Finder, etc.)
			const paths = files.map((file) => window.webUtils.getPathForFile(file));
			text = shellEscapePaths(paths);
		} else {
			// Internal drag (from file tree) - path is in text/plain
			const plainText = event.dataTransfer.getData("text/plain");
			if (!plainText) return;
			text = shellEscapePaths([plainText]);
		}
		if (!isExitedRef.current) {
			writeRef.current({ paneId, data: text });
		}
	};

	return (
		<div
			role="application"
			className="flex h-full w-full flex-col overflow-hidden"
			style={{ backgroundColor: terminalBg }}
			onDragOver={handleDragOver}
			onDrop={handleDrop}
		>
			{/* Agent panes only: slim status header. Always present across all four
			    statuses (a flex child, not an overlay), so status changes never
			    shift terminal layout. */}
			{paneStatus && (
				<TerminalStatusBar
					status={paneStatus}
					echoMs={echoMs ?? undefined}
					onToggleSearch={() => setIsSearchOpen((prev) => !prev)}
				/>
			)}
			<div className="relative min-h-0 w-full flex-1 overflow-hidden">
				<TerminalSearch
					searchAddon={searchAddonRef.current}
					isOpen={isSearchOpen}
					onClose={() => setIsSearchOpen(false)}
				/>
				<ScrollToBottomButton terminal={xtermInstance} />
				{isReadOnly && (
					<button
						type="button"
						onClick={handleTakeControl}
						title="Another device is typing in this terminal. Click to take control."
						className="absolute top-1.5 right-2 z-10 rounded-full border border-white/15 bg-black/60 px-2.5 py-0.5 text-[11px] font-medium text-white/75 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
					>
						View only · Take control
					</button>
				)}
				{exitStatus === "killed" && !connectionError && !isRestoredMode && (
					<SessionKilledOverlay onRestart={restartTerminal} />
				)}
				<div ref={terminalRef} className="h-full w-full" />
				{/* Loud sticky bar, agent panes only, only while blocked on a
				    permission prompt. Absolute overlay so it never reflows the
				    terminal (no layout shift) and sits above the mobile key bar.
				    Clears when status leaves "permission" — incl. the keystroke
				    clear above (no hook fires on denial/Ctrl+C). */}
				{paneStatus === "permission" && (
					<WaitingOnYouBar onClick={() => xtermRef.current?.focus()} />
				)}
			</div>
			{isMobile && (
				<TerminalKeyBar
					onSendKey={handleKeyBarSend}
					onEscape={handleKeyBarEscape}
				/>
			)}
		</div>
	);
};
