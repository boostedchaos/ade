import { SearchIcon } from "lucide-react";
import {
	Iris,
	irisStateForPaneStatus,
} from "renderer/screens/main/components/Iris";
import { getStatusTooltip } from "renderer/screens/main/components/StatusIndicator";
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
		<div
			className="flex shrink-0 items-center gap-2 px-2 font-mono select-none"
			style={{
				height: "var(--argus-statusbar-height)",
				borderBottom: "1px solid var(--argus-hairline)",
				fontSize: "var(--argus-size-status)",
				color: "var(--argus-text-label)",
			}}
		>
			<span
				className="flex items-center gap-1.5"
				title={status === "idle" ? "Idle" : getStatusTooltip(status)}
			>
				{/* The iris now HAS an idle state (an open ring, no pupil), so idle
				    no longer needs a substitute dot. */}
				<Iris state={irisStateForPaneStatus(status)} size={10} decorative />
				<span
					style={{
						color:
							status === "idle"
								? "var(--argus-text-label)"
								: "var(--argus-iris-working)",
					}}
				>
					{STATUS_LABEL[status]}
				</span>
			</span>
			<div className="ml-auto flex items-center gap-2">
				<span
					className="font-mono text-[var(--argus-text-disabled)] tabular-nums"
					title="Keystroke→paint latency"
				>
					{echoMs != null ? `${echoMs}ms` : "—"}
				</span>
				<button
					type="button"
					onClick={onToggleSearch}
					aria-label="Search terminal"
					title="Search"
					className="flex size-5 items-center justify-center rounded text-[var(--argus-text-label)] transition-colors hover:bg-[var(--argus-raised)] hover:text-[var(--argus-text-emphasis)]"
				>
					<SearchIcon className="size-3" />
				</button>
			</div>
		</div>
	);
}
