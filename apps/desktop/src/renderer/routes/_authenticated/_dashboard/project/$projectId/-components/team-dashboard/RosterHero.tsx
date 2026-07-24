import { Skeleton } from "@superset/ui/skeleton";
import { AgentCard } from "./AgentCard";
import type { RosterEntry } from "./types";

interface RosterHeroProps {
	entries: RosterEntry[];
	isLoading: boolean;
	/** The GitHub PR overlay is still resolving; AgentCard reserves the PR slot. */
	isPRLoading?: boolean;
}

/**
 * Header row of the dashboard: one card per agent on the project. This is the
 * "who's on the team and what are they doing right now" glance.
 */
export function RosterHero({ entries, isLoading, isPRLoading }: RosterHeroProps) {
	return (
		<section className="space-y-3">
			<h2 className="text-sm font-medium text-muted-foreground">Team</h2>

			{isLoading && entries.length === 0 ? (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-[92px] w-full rounded-xl" />
					))}
				</div>
			) : entries.length === 0 ? (
				<div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
					No agents on this project yet.
				</div>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{entries.map((entry) => (
						<AgentCard
							key={entry.workspaceId}
							entry={entry}
							prPending={isPRLoading}
						/>
					))}
				</div>
			)}
		</section>
	);
}
