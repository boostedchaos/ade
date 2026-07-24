import { SearchIcon } from "lucide-react";
import {
	getStatusTooltip,
	StatusIndicator,
} from "renderer/screens/main/components/StatusIndicator";
import type { PaneStatus } from "shared/tabs-types";

/** Short label shown next to the dot for each of the four statuses. */
const STATUS_LABEL: Record<PaneStatus, string> = {
	idle: "Idle",
	working: "Working",
	permission: "Needs input",
	review: "Review",
};

interface TerminalStatusBarProps {
	/** Current agent-pane status. All four `PaneStatus` values are rendered. */
	status: PaneStatus;
	/**
	 * Keystroke→paint echo latency in ms (issue #59's `useTerminalLatency`).
	 * Rendered as "—" until that hook is wired in at the mount site — passing a
	 * number here is the only change needed then.
	 */
	echoMs?: number;
	/** Toggle the existing `TerminalSearch` overlay (hotkey-only otherwise). */
	onToggleSearch: () => void;
}

/**
 * Slim (~24px) status header for agent panes only. Terminal-bg-matched (no own
 * background; inherits the pane's terminal background) so it reads as chrome on
 * the terminal, matching the existing terminal overlays' white-on-dark
 * treatment. It is present for an agent pane regardless of which of the four
 * statuses is active, so switching status never shifts layout — only the dot
 * and label change. Plain (non-agent) shells never mount it.
 */
export function TerminalStatusBar({
	status,
	echoMs,
	onToggleSearch,
}: TerminalStatusBarProps) {
	return (
		<div className="flex h-6 shrink-0 items-center gap-2 border-b border-white/10 px-2 text-[11px] text-white/70 select-none">
			<span
				className="flex items-center gap-1.5"
				title={status === "idle" ? "Idle" : getStatusTooltip(status)}
			>
				{status === "idle" ? (
					// StatusIndicator has no idle variant — plain muted dot, mirroring
					// AgentStatusBadge's idle treatment.
					<span className="size-2 shrink-0 rounded-full bg-white/30" />
				) : (
					<StatusIndicator status={status} />
				)}
				<span className="text-white/60">{STATUS_LABEL[status]}</span>
			</span>
			<div className="ml-auto flex items-center gap-2">
				<span
					className="font-mono text-white/45 tabular-nums"
					title="Keystroke→paint latency"
				>
					{echoMs != null ? `${echoMs}ms` : "—"}
				</span>
				<button
					type="button"
					onClick={onToggleSearch}
					aria-label="Search terminal"
					title="Search"
					className="flex size-5 items-center justify-center rounded text-white/50 transition-colors hover:bg-white/10 hover:text-white/80"
				>
					<SearchIcon className="size-3" />
				</button>
			</div>
		</div>
	);
}
