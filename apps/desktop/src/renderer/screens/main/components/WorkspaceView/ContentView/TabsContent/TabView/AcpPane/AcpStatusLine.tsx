import { Button } from "@superset/ui/button";
import { useEffect, useState } from "react";
import { newSessionLabel, restartNeedsConfirm } from "./statusLine";

export type AcpPaneLifecycle =
	| "idle"
	| "starting"
	| "ready"
	| "streaming"
	| "dead";

interface AcpStatusLineProps {
	lifecycle: AcpPaneLifecycle;
	/**
	 * The last failure, VERBATIM — every `acp-*` coded message from Phase 1
	 * lands here unedited (spawn / binary / startup timeout / turn error /
	 * session error / a missing Claude Code). The pane never renders blank on
	 * failure, and never falls back to a terminal.
	 */
	error: string | null;
	/**
	 * Entries in this pane's transcript, which is what a restart discards —
	 * and therefore the only thing that decides whether to confirm.
	 */
	transcriptEntryCount: number;
	onNewSession: () => void;
}

const LIFECYCLE_LABEL: Record<AcpPaneLifecycle, string> = {
	idle: "Idle",
	starting: "Starting…",
	ready: "Ready",
	streaming: "Streaming…",
	dead: "Session ended",
};

export function AcpStatusLine({
	lifecycle,
	error,
	transcriptEntryCount,
	onNewSession,
}: AcpStatusLineProps) {
	/** Two-click confirm: the armed button IS the dialog (no overlay to trap focus). */
	const [armed, setArmed] = useState(false);

	// Disarm whenever the thing being confirmed changes underneath the button.
	// A session that ends while the confirm is up would otherwise leave a
	// "Discard & restart?" pointing at a conversation that is already over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: disarm on subject change, not on `armed`
	useEffect(() => {
		setArmed(false);
	}, [lifecycle]);

	const needsConfirm = restartNeedsConfirm({ lifecycle, transcriptEntryCount });

	const handleClick = () => {
		if (needsConfirm && !armed) {
			setArmed(true);
			return;
		}
		setArmed(false);
		onNewSession();
	};

	return (
		<div className="flex min-h-7 items-center gap-2 border-border/60 border-t px-3 py-1 text-xs">
			<span
				className={[
					"shrink-0",
					lifecycle === "dead" ? "text-destructive" : "text-muted-foreground",
				].join(" ")}
			>
				{LIFECYCLE_LABEL[lifecycle]}
			</span>
			{error && (
				<span
					title={error}
					className="min-w-0 flex-1 truncate text-destructive"
				>
					{error}
				</span>
			)}
			{!error && <span className="flex-1" />}
			{/* Always available (2026-08-22): `/clear` cannot reach an ACP pane —
			    the adapter strips it from `available_commands_update` — so this
			    button is the only way to start a fresh context here. */}
			<Button
				variant="outline"
				size="sm"
				className="h-6 shrink-0 px-2 text-xs"
				onClick={handleClick}
				onBlur={() => setArmed(false)}
				title={
					armed
						? "Click again to discard this conversation and start a new session"
						: "Start a new session in this pane"
				}
			>
				{newSessionLabel(armed)}
			</Button>
		</div>
	);
}
