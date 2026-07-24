import { cn } from "@superset/ui/utils";
import { useSyncExternalStore } from "react";
import {
	isCtrlArmed,
	subscribeCtrlArmed,
	toggleCtrlArmed,
} from "../../key-bar-state";

interface TerminalKeyBarProps {
	/** Send raw bytes to the pty (same path as typed input). */
	onSendKey: (data: string) => void;
	/** Extra hook for Esc (pane status reset), optional. */
	onEscape?: () => void;
}

/**
 * On-screen key strip for phones (PHASE_3 §3): Esc · Tab · Ctrl · arrows · ⏎.
 * Rendered below the terminal on mobile only. Ctrl is sticky — tap Ctrl, then
 * the next character typed on the software keyboard becomes a control code.
 *
 * Buttons preventDefault on pointerdown so tapping them never steals focus
 * from xterm's hidden textarea (which would dismiss the iOS keyboard).
 */
export function TerminalKeyBar({ onSendKey, onEscape }: TerminalKeyBarProps) {
	const ctrlArmed = useSyncExternalStore(
		subscribeCtrlArmed,
		isCtrlArmed,
		() => false,
	);

	const keepTerminalFocus = (e: React.PointerEvent) => e.preventDefault();

	const key = (
		label: React.ReactNode,
		onTap: () => void,
		options?: { active?: boolean; ariaLabel?: string; wide?: boolean },
	) => (
		<button
			type="button"
			onPointerDown={keepTerminalFocus}
			onClick={onTap}
			aria-label={options?.ariaLabel}
			aria-pressed={options?.active}
			className={cn(
				"flex h-11 items-center justify-center rounded-md border border-border/60 bg-muted/40 font-mono text-sm text-foreground/90 select-none",
				"active:bg-accent",
				options?.wide ? "min-w-11 px-2" : "min-w-10 px-1",
				options?.active &&
					"border-primary bg-primary/20 text-primary font-semibold",
			)}
		>
			{label}
		</button>
	);

	return (
		<div
			className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-background px-2 py-1.5 hide-scrollbar"
			style={{ paddingBottom: "max(0.375rem, env(safe-area-inset-bottom))" }}
			data-testid="terminal-key-bar"
		>
			{key(
				"esc",
				() => {
					onEscape?.();
					onSendKey("\x1b");
				},
				{ ariaLabel: "Escape", wide: true },
			)}
			{key("tab", () => onSendKey("\t"), { ariaLabel: "Tab", wide: true })}
			{key("ctrl", () => toggleCtrlArmed(), {
				ariaLabel: "Control (sticky)",
				active: ctrlArmed,
				wide: true,
			})}
			{key("↑", () => onSendKey("\x1b[A"), { ariaLabel: "Arrow up" })}
			{key("↓", () => onSendKey("\x1b[B"), { ariaLabel: "Arrow down" })}
			{key("←", () => onSendKey("\x1b[D"), { ariaLabel: "Arrow left" })}
			{key("→", () => onSendKey("\x1b[C"), { ariaLabel: "Arrow right" })}
			<div className="ml-auto" />
			{key("⏎", () => onSendKey("\r"), { ariaLabel: "Enter", wide: true })}
		</div>
	);
}
