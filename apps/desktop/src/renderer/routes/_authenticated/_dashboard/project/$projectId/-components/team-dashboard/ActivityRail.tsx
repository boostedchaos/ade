import { ScrollArea } from "@superset/ui/scroll-area";
import { Skeleton } from "@superset/ui/skeleton";
import { cn } from "@superset/ui/utils";
import type { IconType } from "react-icons";
import {
	LuCircleCheck,
	LuCircleDot,
	LuGitMerge,
	LuGitPullRequest,
	LuMail,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { formatRelativeTime } from "renderer/lib/formatRelativeTime";
import type { ActivityEvent, ActivityKind } from "./types";

const KIND_META: Record<
	ActivityKind,
	{ icon: IconType; color: string; label: string }
> = {
	"pr-opened": {
		icon: LuGitPullRequest,
		color: "text-emerald-500",
		label: "PR opened",
	},
	"pr-merged": { icon: LuGitMerge, color: "text-purple-500", label: "PR merged" },
	"pr-closed": {
		icon: LuGitPullRequest,
		color: "text-muted-foreground",
		label: "PR closed",
	},
	"issue-opened": {
		icon: LuCircleDot,
		color: "text-emerald-500",
		label: "Issue opened",
	},
	"issue-closed": {
		icon: LuCircleCheck,
		color: "text-purple-500",
		label: "Issue closed",
	},
	mail: { icon: LuMail, color: "text-sky-500", label: "Mail" },
};

function toMillis(at: string): number {
	const parsed = Date.parse(at);
	return Number.isNaN(parsed) ? Date.now() : parsed;
}

interface ActivityRailProps {
	events: ActivityEvent[];
	isLoading: boolean;
}

/**
 * Right-rail feed of recent project activity, newest first. Rows with a url open
 * the target externally (browser / mail client) via the `external` router.
 */
export function ActivityRail({ events, isLoading }: ActivityRailProps) {
	const openUrl = electronTrpc.external.openUrl.useMutation();

	const sorted = [...events].sort((a, b) => toMillis(b.at) - toMillis(a.at));

	return (
		<section className="flex h-full flex-col space-y-3">
			<h2 className="text-sm font-medium text-muted-foreground">Activity</h2>

			{isLoading && events.length === 0 ? (
				<div className="space-y-2">
					{[0, 1, 2, 3, 4].map((i) => (
						<Skeleton key={i} className="h-12 w-full rounded-lg" />
					))}
				</div>
			) : sorted.length === 0 ? (
				<div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
					No recent activity.
				</div>
			) : (
				<ScrollArea className="h-full max-h-[calc(100vh-12rem)] pr-2">
					<ul className="space-y-1">
						{sorted.map((event) => {
							const meta = KIND_META[event.kind];
							const Icon = meta.icon;
							const clickable = !!event.url;
							return (
								<li key={event.id}>
									<button
										type="button"
										disabled={!clickable}
										onClick={() => {
											if (event.url) openUrl.mutate(event.url);
										}}
										className={cn(
											"flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left",
											clickable
												? "cursor-pointer transition-colors hover:bg-accent/50"
												: "cursor-default",
										)}
									>
										<Icon
											className={cn("mt-0.5 size-4 shrink-0", meta.color)}
										/>
										<div className="flex min-w-0 flex-1 flex-col gap-0.5">
											<span className="truncate text-sm text-foreground">
												{event.number != null && (
													<span className="font-mono tabular-nums text-muted-foreground">
														#{event.number}{" "}
													</span>
												)}
												{event.title}
											</span>
											<span className="text-[11px] text-muted-foreground">
												{meta.label}
												{event.actor ? ` · ${event.actor}` : ""} ·{" "}
												{formatRelativeTime(toMillis(event.at))}
											</span>
										</div>
									</button>
								</li>
							);
						})}
					</ul>
				</ScrollArea>
			)}
		</section>
	);
}
