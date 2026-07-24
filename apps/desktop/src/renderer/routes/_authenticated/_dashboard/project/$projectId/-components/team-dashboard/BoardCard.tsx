import { Avatar, AvatarFallback } from "@superset/ui/avatar";
import { Badge } from "@superset/ui/badge";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@superset/ui/hover-card";
import { cn } from "@superset/ui/utils";
import type { BoardItem, ChecksStatus } from "./types";

const CHECKS_LABEL: Record<ChecksStatus, { label: string; color: string }> = {
	success: { label: "Checks passing", color: "text-emerald-500" },
	failure: { label: "Checks failing", color: "text-destructive" },
	pending: { label: "Checks pending", color: "text-amber-500" },
	none: { label: "No checks", color: "text-muted-foreground" },
};

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface BoardCardProps {
	item: BoardItem;
	muted?: boolean;
	onOpen: (url: string) => void;
}

export function BoardCard({ item, muted, onOpen }: BoardCardProps) {
	const hasDetail = !!item.pr || !!item.agent;

	const card = (
		<div
			className={cn(
				"flex flex-col gap-2 rounded-lg border bg-card p-2.5",
				muted && "opacity-70",
			)}
		>
			<div className="flex items-start gap-2">
				{item.agent && (
					<Avatar className="mt-0.5 size-5 shrink-0">
						<AvatarFallback className="text-[9px] font-medium">
							{initials(item.agent.name)}
						</AvatarFallback>
					</Avatar>
				)}
				<button
					type="button"
					onClick={() => onOpen(item.url)}
					className="min-w-0 flex-1 text-left"
				>
					<span className="line-clamp-2 text-sm text-foreground hover:underline">
						<span className="font-mono tabular-nums text-muted-foreground">
							#{item.number}{" "}
						</span>
						{item.title}
					</span>
				</button>
			</div>

			{item.labels.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{item.labels.map((label) => (
						<Badge key={label} variant="secondary" className="text-[10px]">
							{label}
						</Badge>
					))}
				</div>
			)}
		</div>
	);

	if (!hasDetail) return card;

	return (
		<HoverCard openDelay={200} closeDelay={100}>
			<HoverCardTrigger asChild>{card}</HoverCardTrigger>
			<HoverCardContent align="start" className="w-72 space-y-2">
				{item.pr && (
					<div className="space-y-1">
						<div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
							<span className="font-mono tabular-nums text-muted-foreground">
								#{item.pr.number}
							</span>
							<span className="truncate">{item.pr.title}</span>
						</div>
						<div
							className={cn(
								"text-[11px]",
								CHECKS_LABEL[item.pr.checksStatus].color,
							)}
						>
							{CHECKS_LABEL[item.pr.checksStatus].label}
						</div>
					</div>
				)}
				{item.agent && (
					<div className="border-t pt-2 text-[11px] text-muted-foreground">
						<span className="text-foreground">{item.agent.name}</span>
						{item.agent.branch && (
							<span className="block truncate font-mono">
								{item.agent.branch}
							</span>
						)}
					</div>
				)}
			</HoverCardContent>
		</HoverCard>
	);
}
