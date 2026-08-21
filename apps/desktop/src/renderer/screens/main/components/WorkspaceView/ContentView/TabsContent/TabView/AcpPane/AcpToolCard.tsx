import { CodeBlock } from "@superset/ui/ai-elements/code-block";
import {
	Tool,
	ToolContent,
	type ToolDisplayState,
	ToolHeader,
} from "@superset/ui/ai-elements/tool";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@superset/ui/collapsible";
import { memo, useEffect, useState } from "react";
import { HiChevronDown } from "react-icons/hi2";
import { type DiffSide, hiddenLinesLabel, planDiff } from "./toolCard";
import type { AcpToolCallContent, AcpToolCallState } from "./transcript";

/**
 * One tool call, rendered from the merged state of every frame that named it.
 *
 * `in_progress` maps to a distinct display state even though the wire has
 * never sent one: it exists for long-running tools with progress heartbeats,
 * so a card that cannot show it would silently mislabel the first one we see.
 */
const STATUS_DISPLAY: Record<string, ToolDisplayState> = {
	pending: "input-available",
	in_progress: "input-complete",
	completed: "output-available",
	failed: "output-error",
};

/**
 * Memoised on `call`: the reducer replaces the tool state object only on a
 * frame that named this id, so reference equality is exact — without it every
 * card in the transcript re-renders on every streamed chunk of assistant text.
 */
export const AcpToolCard = memo(function AcpToolCard({
	call,
}: {
	call: AcpToolCallState;
}) {
	const failed = call.status === "failed";
	const [open, setOpen] = useState(false);

	// A card that starts `pending` and later fails must open itself: `defaultOpen`
	// is read once at mount, and the failure arrives many frames later.
	useEffect(() => {
		if (failed) setOpen(true);
	}, [failed]);

	const content = call.content ?? [];
	const hasBody = content.length > 0 || call.rawInput !== undefined;

	return (
		<Tool className="mb-3" onOpenChange={setOpen} open={open}>
			<ToolHeader
				state={STATUS_DISPLAY[call.status ?? ""] ?? "awaiting-input"}
				title={call.title ?? call.toolCallId}
			>
				{call.toolName && (
					<span className="shrink-0 rounded border border-border/60 px-1 text-[10px] text-muted-foreground">
						{call.toolName}
					</span>
				)}
			</ToolHeader>
			<ToolContent>
				{hasBody ? (
					<div className="space-y-2 p-2 text-xs">
						{content.map((block, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the wire gives content blocks no id, and the collection is replaced wholesale
							<AcpToolContentBlock block={block} key={index} />
						))}
						{call.rawInput !== undefined && (
							<AcpRawInput rawInput={call.rawInput} />
						)}
					</div>
				) : (
					<div className="p-2 text-muted-foreground text-xs">
						No output reported.
					</div>
				)}
			</ToolContent>
		</Tool>
	);
});

function AcpToolContentBlock({ block }: { block: AcpToolCallContent }) {
	if (block.type === "diff") {
		return (
			<AcpDiffBlock
				newText={block.newText}
				oldText={block.oldText}
				path={block.path}
			/>
		);
	}

	if (block.type === "content" && block.content.type === "text") {
		return (
			<div className="whitespace-pre-wrap break-words font-mono text-muted-foreground">
				{block.content.text}
			</div>
		);
	}

	// Images, embedded resources and terminal blocks have no renderer yet; the
	// type is shown rather than the block dropped, so a gap reads as a gap.
	return (
		<div className="text-muted-foreground">
			{block.type === "content"
				? `(${block.content.type} content)`
				: `(${block.type})`}
		</div>
	);
}

/**
 * A minimal removed-then-added block rather than `FileDiffTool`, which brings
 * its own card header and file dropdown — a second header inside this one.
 *
 * Which rows exist is `planDiff`'s call, not this component's: a new file has
 * no removed side, and a side longer than the cap ends in a count instead of
 * thousands of nodes.
 */
function AcpDiffBlock({
	path,
	oldText,
	newText,
}: {
	path: string;
	oldText: string | null | undefined;
	newText: string;
}) {
	const { removed, added } = planDiff(oldText, newText);

	return (
		<div className="overflow-hidden rounded border border-border/60">
			<div className="truncate border-border/60 border-b px-2 py-1 text-muted-foreground">
				{path}
			</div>
			<div className="overflow-x-auto font-mono">
				{removed && (
					<AcpDiffSide
						className="bg-destructive/10"
						keyPrefix="old"
						marker="- "
						side={removed}
					/>
				)}
				<AcpDiffSide
					className="bg-primary/10"
					keyPrefix="new"
					marker="+ "
					side={added}
				/>
			</div>
		</div>
	);
}

function AcpDiffSide({
	side,
	marker,
	className,
	keyPrefix,
}: {
	side: DiffSide;
	marker: string;
	className: string;
	keyPrefix: string;
}) {
	return (
		<>
			{side.lines.map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: line position IS the identity here
				<div className={`px-2 ${className}`} key={`${keyPrefix}-${index}`}>
					<span className="select-none text-muted-foreground">{marker}</span>
					{line}
				</div>
			))}
			{side.hidden > 0 && (
				<div className="px-2 py-1 text-muted-foreground italic">
					{hiddenLinesLabel(side.hidden)}
				</div>
			)}
		</>
	);
}

function AcpRawInput({ rawInput }: { rawInput: unknown }) {
	return (
		<Collapsible>
			<CollapsibleTrigger className="group flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
				<HiChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" />
				Input
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-1 overflow-hidden rounded border border-border/60">
				<CodeBlock code={formatJson(rawInput)} language="json" />
			</CollapsibleContent>
		</Collapsible>
	);
}

function formatJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		// Cyclic or otherwise unserializable input is the adapter's business, not
		// a reason for the card to disappear.
		return String(value);
	}
}
