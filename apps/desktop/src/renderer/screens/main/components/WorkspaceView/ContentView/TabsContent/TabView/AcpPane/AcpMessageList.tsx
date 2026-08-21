import { useEffect, useRef } from "react";
import type { AcpEntry } from "./transcript";

interface AcpMessageListProps {
	entries: AcpEntry[];
	/** True while a turn is streaming; drives the stick-to-bottom behaviour. */
	isStreaming: boolean;
}

/**
 * Plain-text scrollback. No markdown rendering and no virtualization — both
 * are Phase 3 concerns, and neither is needed to verify text in / text out.
 */
export function AcpMessageList({ entries, isStreaming }: AcpMessageListProps) {
	const bottomRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	/** Only auto-scroll while the user is already at the bottom. */
	const stickToBottom = useRef(true);

	const handleScroll = () => {
		const container = containerRef.current;
		if (!container) return;
		const distance =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		stickToBottom.current = distance < 40;
	};

	useEffect(() => {
		if (!stickToBottom.current) return;
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every content change, which the entries array identity tracks
	useEffect(() => {
		if (!stickToBottom.current) return;
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [entries, isStreaming]);

	if (entries.length === 0) {
		return (
			<div className="flex h-full w-full items-center justify-center px-6 text-center text-muted-foreground text-xs">
				No messages yet. Type below to start the conversation.
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			onScroll={handleScroll}
			className="h-full w-full overflow-y-auto px-3 py-2 text-base"
		>
			{entries.map((entry) => (
				<AcpMessage key={entry.id} entry={entry} />
			))}
			{isStreaming && !hasOpenAssistantEntry(entries) && <AcpThinkingRow />}
			<div ref={bottomRef} />
		</div>
	);
}

/**
 * True while an assistant entry is already accumulating text — that entry draws
 * its own caret, so the standalone thinking row would be a second indicator.
 */
function hasOpenAssistantEntry(entries: AcpEntry[]): boolean {
	const last = entries[entries.length - 1];
	return last?.role === "assistant" && last.closed === false;
}

/**
 * The adapter does not stream token-by-token: a turn can sit silent for over a
 * second before its first chunk arrives, and no assistant entry exists yet to
 * carry the caret. Without this the pane looks dead for that whole window.
 */
function AcpThinkingRow() {
	return (
		<div className="mb-3">
			<div className="mb-0.5 font-medium text-muted-foreground text-sm">
				Agent
			</div>
			<div className="flex items-center gap-1.5 text-muted-foreground">
				<span className="size-1.5 animate-pulse rounded-full bg-current" />
				<span className="text-sm">Thinking…</span>
			</div>
		</div>
	);
}

function AcpMessage({ entry }: { entry: AcpEntry }) {
	if (entry.role === "divider") {
		return (
			<div className="my-3 flex items-center gap-2 text-muted-foreground text-xs">
				<div className="h-px flex-1 bg-border" />
				<span className="whitespace-pre-wrap break-words">{entry.text}</span>
				<div className="h-px flex-1 bg-border" />
			</div>
		);
	}

	const isUser = entry.role === "user";
	return (
		<div className="mb-3">
			<div className="mb-0.5 font-medium text-muted-foreground text-sm">
				{isUser ? "You" : "Agent"}
			</div>
			<div
				className={[
					"whitespace-pre-wrap break-words",
					isUser ? "text-foreground/90" : "text-foreground",
				].join(" ")}
			>
				{entry.text}
				{entry.role === "assistant" && entry.closed === false && (
					<span className="ml-0.5 inline-block animate-pulse">▍</span>
				)}
			</div>
		</div>
	);
}
