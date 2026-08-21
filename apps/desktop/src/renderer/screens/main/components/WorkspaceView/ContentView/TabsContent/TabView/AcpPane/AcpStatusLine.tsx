import { Button } from "@superset/ui/button";

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
	onNewSession,
}: AcpStatusLineProps) {
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
			{lifecycle === "dead" && (
				<Button
					variant="outline"
					size="sm"
					className="h-6 shrink-0 px-2 text-xs"
					onClick={onNewSession}
				>
					New session
				</Button>
			)}
		</div>
	);
}
