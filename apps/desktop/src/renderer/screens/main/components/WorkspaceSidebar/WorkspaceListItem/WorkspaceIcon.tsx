import { cn } from "@superset/ui/utils";
import { AttentionBadge } from "renderer/screens/main/components/AttentionBadge";
import {
	Iris,
	irisStateForPaneStatus,
} from "renderer/screens/main/components/Iris";
import type { ActivePaneStatus } from "shared/tabs-types";

interface WorkspaceIconProps {
	isBranchWorkspace: boolean;
	isActive: boolean;
	isUnread: boolean;
	workspaceStatus: ActivePaneStatus | null;
	/** Unread attention notifications across every pane in this workspace. */
	attentionCount: number;
	variant: "collapsed" | "expanded";
	/** Optional custom icon (e.g. an agent bust). Overrides the laptop/folder
	 * glyph when present. Used by the agent-fleet "Space" model. */
	iconUrl?: string | null;
	/** Optional Space brand tint rendered as a tile behind the bust. */
	tintColor?: string | null;
}

const OVERLAY_POSITION = {
	collapsed: "top-1 right-1",
	expanded: "-top-0.5 -right-0.5",
} as const;

/**
 * The leading element of a rail row.
 *
 * Under Argus this is the iris and nothing else (DESIGN-BRIEF.md §2a, and the
 * 2a mock: every rail row is iris + name + a right-aligned count). It replaces
 * three things that used to compete for this slot — the ASCII spinner shown
 * while working, the agent bust avatar, and the folder/laptop repo glyph — plus
 * the corner status dot that sat on top of them.
 *
 * DELIBERATE INFORMATION LOSS, recorded rather than hidden: the folder-vs-
 * laptop glyph distinguished a branch workspace from a repo workspace, and the
 * iris does not carry that bit. The mocks show no repo-type marker in the rail,
 * so this follows the design; `isBranchWorkspace` is kept in the props so the
 * distinction can be re-surfaced without an API change if it turns out to be
 * missed.
 */
export function WorkspaceIcon({
	isActive,
	isUnread,
	workspaceStatus,
	attentionCount,
	variant,
}: WorkspaceIconProps) {
	const overlayPosition = OVERLAY_POSITION[variant];

	return (
		<>
			<Iris
				state={
					workspaceStatus ? irisStateForPaneStatus(workspaceStatus) : "idle"
				}
				size={14}
				// The row's own label names the agent and its state in text.
				decorative
				className={cn(!isActive && "opacity-90")}
			/>
			{/*
			 * The count outranks the status iris: with several panes blocked, "3"
			 * is strictly more information than a ring, and showing both in the
			 * same corner would just overlap them.
			 */}
			{attentionCount > 0 && (
				<span className={cn("absolute", overlayPosition)}>
					<AttentionBadge count={attentionCount} size="sm" />
				</span>
			)}
			{isUnread && !workspaceStatus && attentionCount === 0 && (
				<span className={cn("absolute flex size-1.5", overlayPosition)}>
					<span className="relative inline-flex size-1.5 rounded-full bg-[var(--argus-iris-working)]" />
				</span>
			)}
		</>
	);
}
