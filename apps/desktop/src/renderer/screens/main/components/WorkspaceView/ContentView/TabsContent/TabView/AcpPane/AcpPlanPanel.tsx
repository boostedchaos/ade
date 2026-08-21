import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@superset/ui/collapsible";
import { HiChevronDown } from "react-icons/hi2";
import type { AcpPlanEntry } from "./transcript";

/**
 * The agent's plan, pinned above the scrollback so it stays reachable while
 * the conversation grows past it.
 *
 * No priority column: TodoWrite hardcodes `priority: "medium"` on every entry
 * it produces, so the field carries no information on this wire. A plan with
 * no matching tool cards is also correct — TodoWrite never produces one.
 */
const STATUS_ICON: Record<string, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
};

export function AcpPlanPanel({ entries }: { entries: AcpPlanEntry[] }) {
	const done = entries.filter((entry) => entry.status === "completed").length;

	return (
		<Collapsible className="border-border/60 border-b">
			<CollapsibleTrigger className="group flex h-6 w-full items-center gap-1 px-3 text-muted-foreground text-xs hover:text-foreground">
				<HiChevronDown className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
				<span>{`Plan · ${done}/${entries.length} done`}</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="max-h-40 overflow-y-auto px-3 pb-2">
				{entries.map((entry, index) => (
					<div
						className="flex items-start gap-1.5 py-0.5 text-xs"
						// biome-ignore lint/suspicious/noArrayIndexKey: the wire gives plan entries no id, and the list is replaced wholesale
						key={index}
					>
						<span className="shrink-0 text-muted-foreground">
							{STATUS_ICON[entry.status] ?? "○"}
						</span>
						<span
							className={
								entry.status === "completed"
									? "text-muted-foreground line-through"
									: "text-foreground"
							}
						>
							{entry.content}
						</span>
					</div>
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}
