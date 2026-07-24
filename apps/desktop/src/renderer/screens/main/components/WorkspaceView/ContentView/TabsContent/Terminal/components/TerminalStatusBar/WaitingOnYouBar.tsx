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
			className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-center gap-2 border-t border-amber-500/40 bg-amber-500/15 px-3 py-2 text-sm font-semibold text-amber-700 backdrop-blur-sm transition-colors hover:bg-amber-500/25 dark:bg-amber-400/15 dark:text-amber-300"
		>
			<span className="relative flex size-2 shrink-0">
				<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
				<span className="relative inline-flex size-2 rounded-full bg-amber-500" />
			</span>
			Waiting on you — click to respond
		</button>
	);
}
