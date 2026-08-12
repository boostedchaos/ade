import { Iris } from "renderer/screens/main/components/Iris";

interface WaitingOnYouBarProps {
	/** Focus the terminal so the user can type their response immediately. */
	onClick: () => void;
}

/**
 * Loud sticky bar shown only while an agent pane is blocked on a permission
 * prompt (`status === "permission"`). Absolutely positioned over the bottom of
 * the terminal container so it never reflows terminal content (no layout shift)
 * and sits above the mobile `TerminalKeyBar` (a separate sibling rendered below
 * the terminal container). Clicking focuses the terminal so the user can answer.
 *
 * Style language mirrors `AgentStatusBadge`'s amber "Waiting on you" state.
 *
 * Clearing is the mount site's responsibility: the bar unmounts as soon as
 * status leaves "permission" — including the keystroke-driven clear in
 * `Terminal.tsx` (no agent hook fires on permission denial or Ctrl+C).
 */
export function WaitingOnYouBar({ onClick }: WaitingOnYouBarProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-center gap-2 border-t border-[var(--argus-ring-amber)] bg-[var(--argus-wash-amber)] px-3 py-2 text-[13px] text-[var(--argus-text-amber)] transition-colors hover:bg-[var(--argus-ring-amber)]"
		>
			<Iris state="waiting" size={12} decorative />
			Waiting on you — click to respond
		</button>
	);
}
