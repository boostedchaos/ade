import { Button } from "@superset/ui/button";
import { useEffect, useRef, useState } from "react";
import {
	type AcpCommand,
	type AcpCommandsState,
	acceptCommand,
	commandHint,
	commandSummary,
	emptyCommands,
	filterCommands,
	slashQuery,
	useAcpCommandsStore,
} from "./commands";

/** Stable identity, for the same reason `AcpPane`'s empty transcript is. */
const EMPTY_COMMANDS: AcpCommandsState = emptyCommands();

/** Roughly eight rows, then the list scrolls. */
const PALETTE_MAX_HEIGHT = "max-h-[15rem]";

interface AcpComposerProps {
	paneId: string;
	/** True while a turn is in flight: the textarea disables, Stop appears. */
	isBusy: boolean;
	/** False while there is no live session (starting, or dead). */
	canSend: boolean;
	onSend: (text: string) => void;
	onCancel: () => void;
}

export function AcpComposer({
	paneId,
	isBusy,
	canSend,
	onSend,
	onCancel,
}: AcpComposerProps) {
	const [value, setValue] = useState("");
	const [caret, setCaret] = useState(0);
	// Escape closes the palette without clearing the text; typing reopens it.
	const [dismissed, setDismissed] = useState(false);
	const [selected, setSelected] = useState(0);
	// The accepted command's argument hint, shown until the user types or sends.
	const [hint, setHint] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const { commands } = useAcpCommandsStore(
		(store) => store.byPane[paneId] ?? EMPTY_COMMANDS,
	);

	const query = slashQuery(value, caret);
	const paletteOpen = query !== null && !dismissed;
	const matches = query === null ? [] : filterCommands(commands, query);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the highlight follows the query, not the array identity
	useEffect(() => {
		setSelected(0);
	}, [query]);

	const submit = () => {
		const text = value.trim();
		if (!text || isBusy || !canSend) return;
		setValue("");
		setCaret(0);
		setHint(null);
		setDismissed(false);
		onSend(text);
	};

	const accept = (command: AcpCommand) => {
		const next = acceptCommand(value, command.name);
		setValue(next.text);
		setCaret(next.caret);
		setHint(commandHint(command));
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
		if (paletteOpen) {
			// Every key the palette owns is swallowed here: Enter reaching the
			// composer would send `/wr` as a prompt, and Escape would cancel the
			// turn instead of closing the list.
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (matches.length === 0) return;
				const step = event.key === "ArrowDown" ? 1 : -1;
				setSelected(
					(current) => (current + step + matches.length) % matches.length,
				);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				const command = matches[selected];
				if (command) accept(command);
				// Nothing to accept — dismiss, so a second Enter sends what was typed
				// rather than doing nothing twice.
				else setDismissed(true);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setDismissed(true);
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
			return;
		}
		// Esc cancels the turn — the same thing the Stop button does, so a user
		// who never looks at the buttons still has a way out.
		if (event.key === "Escape" && isBusy) {
			event.preventDefault();
			onCancel();
		}
	};

	return (
		<div className="flex items-end gap-2 border-border/60 border-t p-2">
			<div className="relative min-w-0 flex-1">
				{paletteOpen && (
					<div className="absolute right-0 bottom-full left-0 z-50 mb-1 overflow-hidden rounded-md border border-border bg-popover shadow-md">
						<div className={`${PALETTE_MAX_HEIGHT} overflow-y-auto py-1`}>
							{commands.length === 0 ? (
								// Distinct from "no matching commands" on purpose (D4): an
								// empty palette and a dead subscription look identical, so
								// the pre-notification state says which one this is.
								<div className="px-2 py-1.5 text-muted-foreground text-xs">
									commands not loaded yet
								</div>
							) : matches.length === 0 ? (
								<div className="px-2 py-1.5 text-muted-foreground text-xs">
									no matching commands
								</div>
							) : (
								matches.map((command, index) => (
									<button
										className={`flex w-full min-w-0 items-baseline gap-2 px-2 py-1 text-left text-xs ${
											index === selected
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
				<textarea
					ref={textareaRef}
					value={value}
					onChange={(event) => {
						setValue(event.target.value);
						setCaret(event.target.selectionStart);
						setDismissed(false);
						setHint(null);
					}}
					onSelect={(event) =>
						setCaret(event.currentTarget.selectionStart ?? 0)
					}
					onKeyDown={handleKeyDown}
					disabled={isBusy || !canSend}
					rows={2}
					placeholder={
						canSend
							? (hint ??
								"Message the agent…  (Enter to send, Shift+Enter for newline)")
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
