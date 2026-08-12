import { cn } from "@superset/ui/utils";
import type { ActivePaneStatus } from "shared/tabs-types";
import { getIrisLabel, Iris, irisStateForPaneStatus } from "../Iris";

// Re-export for consumers
export type { ActivePaneStatus } from "shared/tabs-types";

/**
 * Visual indicator for pane/workspace status.
 *
 * Under Argus this IS the iris — an open ring with a pupil — not a filled dot.
 * The component is kept so the eight existing call sites do not each need to
 * learn the PaneStatus -> IrisState mapping; it is now a thin adapter over
 * `<Iris>`.
 *
 * The state colors changed with the rebrand (SPEC.md §Rulings 1):
 * - working: blue ring, filled pupil   (was amber)
 * - permission -> "waiting on you": amber ring, filled pupil   (was red)
 * - review: green ring, no pupil
 */
interface StatusIndicatorProps {
	status: ActivePaneStatus;
	className?: string;
	/** Rendered size in px; defaults to the 14px base geometry. */
	size?: number;
	/**
	 * Pulse the attention ring. Only `permission` pulses, and only three times
	 * — motion reports state, it does not decorate.
	 */
	pulse?: boolean;
}

export function StatusIndicator({
	status,
	className,
	size = 14,
	pulse = false,
}: StatusIndicatorProps) {
	return (
		<Iris
			state={irisStateForPaneStatus(status)}
			size={size}
			pulse={pulse}
			className={cn(className)}
			decorative
		/>
	);
}

/** Get tooltip text for a status - for consumers that wrap with Tooltip */
export function getStatusTooltip(status: ActivePaneStatus): string {
	return getIrisLabel(irisStateForPaneStatus(status));
}
