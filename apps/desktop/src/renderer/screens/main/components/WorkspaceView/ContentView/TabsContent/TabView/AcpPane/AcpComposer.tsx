import { Button } from "@superset/ui/button";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AcpPaneLifecycle } from "./AcpStatusLine";
import {
	type AcpCommand,
	type AcpCommandsState,
	type ActiveHint,
	acceptCommand,
	clampSelected,
	commandHint,
	commandSummary,
	emptyCommands,
	emptyPaletteMessage,
	filterCommands,
	hintVisible,
	PALETTE_MAX_PX,
	paletteMaxHeight,
	slashQuery,
	useAcpCommandsStore,
} from "./commands";

/** Stable identity, for the same reason `AcpPane`'s empty transcript is. */
const EMPTY_COMMANDS: AcpCommandsState = emptyCommands();

/** The `mb-1` between the panel and the composer, in the same units as the measurement. */
const PALETTE_GAP_PX = 4;

/**
 * Room between the composer and whatever first clips the pane.
 *
 * The palette grows upward inside an `overflow-hidden` ancestor, so the ceiling
 * is not the viewport — it is the nearest clipping box. Walking up to it is the
 * only way to learn that number; there is no automated test for this function
 * (it is pure DOM), which is why the arithmetic it feeds lives in
 * `paletteMaxHeight`.
 */
function spaceAboveComposer(element: HTMLElement): number {
	const top = element.getBoundingClientRect().top;
	for (let node = element.parentElement; node; node = node.parentElement) {
		const { overflow, overflowY } = getComputedStyle(node);
		if (overflow !== "visible" || overflowY !== "visible") {
			return top - node.getBoundingClientRect().top - PALETTE_GAP_PX;
		}
	}
	return top - PALETTE_GAP_PX;
}

interface AcpComposerProps {
	paneId: string;
	/** True while a turn is in flight: the textarea disables, Stop appears. */
	isBusy: boolean;
	/** False while there is no live session (starting, or dead). */
	canSend: boolean;
	/**
	 * The pane's session state. The palette's empty message keys on this: an
	 * empty list means "not loaded yet" while a session is coming up and
	 * "unavailable" once it is gone, and the array cannot tell them apart.
	 */
	lifecycle: AcpPaneLifecycle;
	onSend: (text: string) => void;
	onCancel: () => void;
}

export function AcpComposer({
	paneId,
	isBusy,
	canSend,
	lifecycle,
	onSend,
	onCancel,
}: AcpComposerProps) {
	const [value, setValue] = useState("");
	const [caret, setCaret] = useState(0);
	// Escape closes the palette without clearing the text; typing reopens it.
	const [dismissed, setDismissed] = useState(false);
	const [selected, setSelected] = useState(0);
	// The accepted command's argument hint, shown while its arguments are empty.
	const [activeHint, setActiveHint] = useState<ActiveHint | null>(null);
	// An IME is mid-composition: Enter commits a candidate, it does not send.
	const [isComposing, setIsComposing] = useState(false);
	const [maxHeight, setMaxHeight] = useState(PALETTE_MAX_PX);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const anchorRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const { commands } = useAcpCommandsStore(
		(store) => store.byPane[paneId] ?? EMPTY_COMMANDS,
	);

	const query = slashQuery(value, caret);
	const paletteOpen = query !== null && !dismissed;
	const matches = query === null ? [] : filterCommands(commands, query);
	// Derived, never trusted from state: an update that shrinks the list leaves
	// `selected` past the end without the query moving, and `matches[selected]`
	// would then be undefined.
	const highlighted = clampSelected(selected, matches.length);
	const showHint = hintVisible(activeHint, value);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the highlight follows the query, not the array identity
	useEffect(() => {
		setSelected(0);
	}, [query]);

	// Keyboard navigation past the eighth row is invisible without this: the
	// panel scrolls, the highlight does not. Same fix as BrowserPane's
	// UrlSuggestions.
	useEffect(() => {
		if (!paletteOpen) return;
		const row = listRef.current?.children[highlighted];
		if (row instanceof HTMLElement) row.scrollIntoView({ block: "nearest" });
	}, [paletteOpen, highlighted]);

	// Measured on open, before paint: a panel taller than the room above it is
	// clipped at the TOP, which is where the best matches are.
	useLayoutEffect(() => {
		if (!paletteOpen || !anchorRef.current) return;
		setMaxHeight(paletteMaxHeight(spaceAboveComposer(anchorRef.current)));
	}, [paletteOpen]);

	const submit = () => {
		const text = value.trim();
		if (!text || isBusy || !canSend) return;
		setValue("");
		setCaret(0);
		setActiveHint(null);
		setDismissed(false);
		onSend(text);
	};

	const accept = (command: AcpCommand) => {
		const next = acceptCommand(value, command.name);
		const hint = commandHint(command);
		setValue(next.text);
		setCaret(next.caret);
		setActiveHint(hint ? { name: command.name, hint } : null);
		setDismissed(false);
		// The caret must land past the inserted name, or the palette reopens on
		// its own trigger rule the moment the textarea reports its old position.
		requestAnimationFrame(() => {
			const textarea = textareaRef.current;
			if (!textarea) return;
			textarea.focus();
			textarea.setSelectionRange(next.caret, next.caret);
		});
	};

	const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// An IME candidate window owns Enter, Tab and Escape while it is up.
		// Acting on them here accepts a command the user was still spelling.
		const composing = isComposing || event.nativeEvent.isComposing;

		if (paletteOpen) {
			// Every key the palette owns is swallowed here: Enter reaching the
			// composer would send `/wr` as a prompt, and Escape would cancel the
			// turn instead of closing the list.
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (matches.length === 0) return;
				const step = event.key === "ArrowDown" ? 1 : -1;
				setSelected((highlighted + step + matches.length) % matches.length);
				return;
			}
			if (!composing && (event.key === "Enter" || event.key === "Tab")) {
				event.preventDefault();
				const command = matches[highlighted];
				if (command) accept(command);
				// Nothing to accept — dismiss, so a second Enter sends what was typed
				// rather than doing nothing twice.
				else setDismissed(true);
				return;
			}
			if (!composing && event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setDismissed(true);
				return;
			}
		}
		if (!composing && event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
			return;
		}
		// Esc cancels the turn — the same thing the Stop button does, so a user
		// who never looks at the buttons still has a way out.
		if (!composing && event.key === "Escape" && isBusy) {
			event.preventDefault();
			onCancel();
		}
	};

	return (
		<div className="flex items-end gap-2 border-border/60 border-t p-2">
			<div className="relative min-w-0 flex-1" ref={anchorRef}>
				{paletteOpen && (
					<div className="absolute right-0 bottom-full left-0 z-50 mb-1 overflow-hidden rounded-md border border-border bg-popover shadow-md">
						<div
							className="overflow-y-auto py-1"
							ref={listRef}
							style={{ maxHeight }}
						>
							{commands.length === 0 ? (
								// Distinct from "no matching commands" on purpose (D4): an
								// empty palette and a dead subscription look identical, so
								// this says which one it is — and the lifecycle, not the
								// list length, is what knows.
								<div className="px-2 py-1.5 text-muted-foreground text-xs">
									{emptyPaletteMessage(lifecycle)}
								</div>
							) : matches.length === 0 ? (
								<div className="px-2 py-1.5 text-muted-foreground text-xs">
									no matching commands
								</div>
							) : (
								matches.map((command, index) => (
									<button
										className={`flex w-full min-w-0 items-baseline gap-2 px-2 py-1 text-left text-xs ${
											index === highlighted
												? "bg-accent text-accent-foreground"
												: ""
										}`}
										key={command.name}
										// The textarea keeps focus and the keyboard: a mousedown
										// that blurred it would close the palette before the
										// click landed.
										onMouseDown={(event) => event.preventDefault()}
										onClick={() => accept(command)}
										onMouseEnter={() => setSelected(index)}
										type="button"
									>
										<span className="shrink-0 font-medium">{`/${command.name}`}</span>
										<span className="min-w-0 truncate text-muted-foreground">
											{commandSummary(command.description)}
										</span>
									</button>
								))
							)}
						</div>
					</div>
				)}
				{showHint && activeHint && (
					// An inline strip, not the textarea's placeholder: accepting always
					// leaves `/name `, and a placeholder paints only an EMPTY textarea,
					// so the placeholder variant would render never (A2).
					<div className="mb-1 truncate px-1 text-muted-foreground text-xs">
						{activeHint.hint}
					</div>
				)}
				<textarea
					ref={textareaRef}
					value={value}
					onChange={(event) => {
						setValue(event.target.value);
						setCaret(event.target.selectionStart);
						setDismissed(false);
					}}
					onSelect={(event) =>
						setCaret(event.currentTarget.selectionStart ?? 0)
					}
					onCompositionStart={() => setIsComposing(true)}
					onCompositionEnd={() => setIsComposing(false)}
					onKeyDown={handleKeyDown}
					disabled={isBusy || !canSend}
					rows={2}
					placeholder={
						canSend
							? "Message the agent…  (Enter to send, Shift+Enter for newline)"
							: "No live session"
					}
					className="min-h-[3rem] w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-base outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
				/>
			</div>
			{isBusy ? (
				<Button variant="outline" size="sm" onClick={onCancel}>
					Stop
				</Button>
			) : (
				<Button
					size="sm"
					disabled={!canSend || value.trim().length === 0}
					onClick={submit}
				>
					Send
				</Button>
			)}
		</div>
	);
}
