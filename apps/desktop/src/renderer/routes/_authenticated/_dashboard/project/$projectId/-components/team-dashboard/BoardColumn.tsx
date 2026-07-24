import { Skeleton } from "@superset/ui/skeleton";
import { cn } from "@superset/ui/utils";
import { BoardCard } from "./BoardCard";
import type { BoardItem } from "./types";

interface BoardColumnProps {
	title: string;
	items: BoardItem[];
	isLoading: boolean;
	muted?: boolean;
	onOpen: (url: string) => void;
}

export function BoardColumn({
	title,
	items,
	isLoading,
	muted,
	onOpen,
}: BoardColumnProps) {
	return (
		<div className="flex min-w-0 flex-col gap-2 rounded-xl border bg-muted/20 p-2.5">
			<div className="flex items-center justify-between px-1">
				<span
					className={cn(
						"text-xs font-medium",
						muted ? "text-muted-foreground/70" : "text-muted-foreground",
					)}
				>
					{title}
				</span>
				<span className="text-[11px] tabular-nums text-muted-foreground/70">
					{items.length}
				</span>
			</div>

			{isLoading && items.length === 0 ? (
				<div className="space-y-2">
					{[0, 1].map((i) => (
						<Skeleton key={i} className="h-16 w-full rounded-lg" />
					))}
				</div>
			) : items.length === 0 ? (
				<div className="px-1 py-4 text-center text-[11px] text-muted-foreground/60">
					Nothing here
				</div>
			) : (
				<div className="space-y-2">
					{items.map((item) => (
						<BoardCard
							key={item.number}
							item={item}
							muted={muted}
							onOpen={onOpen}
						/>
					))}
				</div>
			)}
		</div>
	);
}
