import { ActivityRail } from "./ActivityRail";
import { RosterHero } from "./RosterHero";
import { useTeamDashboard } from "./useTeamDashboard";
import { WorkBoard } from "./WorkBoard";

interface TeamDashboardProps {
	projectId: string;
}

/**
 * Live team dashboard for a project (issue #51). Replaces the create-agent wizard
 * as the project landing: a roster of agents on top, the work board below, and a
 * running activity feed in the right rail. Everything polls on its own cadence
 * via useTeamDashboard, so this is meant to be left open and watched.
 */
export function TeamDashboard({ projectId }: TeamDashboardProps) {
	const {
		roster,
		activity,
		board,
		isRosterLoading,
		isRosterGitHubLoading,
		isActivityLoading,
		isBoardLoading,
	} = useTeamDashboard(projectId);

	return (
		<div className="flex-1 h-full overflow-hidden bg-background text-foreground">
			<div className="h-full overflow-y-auto">
				<div className="mx-auto max-w-[1400px] px-6 py-6">
					<div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
						<div className="min-w-0 space-y-6">
							<RosterHero
								entries={roster}
								isLoading={isRosterLoading}
								isPRLoading={isRosterGitHubLoading}
							/>
							<WorkBoard board={board} isLoading={isBoardLoading} />
						</div>
						<div className="min-w-0">
							<ActivityRail events={activity} isLoading={isActivityLoading} />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
