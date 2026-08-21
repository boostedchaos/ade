import { Button } from "@superset/ui/button";
import { useState } from "react";

interface AcpComposerProps {
	/** True while a turn is in flight: the textarea disables, Stop appears. */
	isBusy: boolean;
	/** False while there is no live session (starting, or dead). */
	canSend: boolean;
	onSend: (text: string) => void;
	onCancel: () => void;
}

export function AcpComposer({
	isBusy,
	canSend,
	onSend,
	onCancel,
}: AcpComposerProps) {
	const [value, setValue] = useState("");

	const submit = () => {
		const text = value.trim();
		if (!text || isBusy || !canSend) return;
		setValue("");
		onSend(text);
	};

	const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
			<textarea
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={handleKeyDown}
				disabled={isBusy || !canSend}
				rows={2}
				placeholder={
					canSend
						? "Message the agent…  (Enter to send, Shift+Enter for newline)"
						: "No live session"
				}
				className="min-h-[3rem] flex-1 resize-none rounded-md border border-border bg-background px-2 py-1.5 text-base outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
			/>
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
