import { Badge } from "@superset/ui/badge";
import { StatusIndicator } from "renderer/screens/main/components/StatusIndicator";
import type { AgentStatus } from "./types";

interface AgentStatusBadgeProps {
	status: AgentStatus;
}

/**
 * Status pill for a roster agent.
 *
 * The two "act on now" states are loud badges so they read across the room:
 *   - "blocked"  -> destructive badge (CI failed / hard-blocked)
 *   - "waiting"  -> amber "Waiting on you" badge (agent needs input)
 * The quiet states reuse the shared StatusIndicator dot with a muted label:
 *   - "working"  -> amber pulsing dot
 *   - "idle"     -> static muted dot
 * "unknown" renders nothing.
 */
export function AgentStatusBadge({ status }: AgentStatusBadgeProps) {
	if (status === "unknown") return null;

	if (status === "blocked") {
		return <Badge variant="destructive">Blocked</Badge>;
	}

	if (status === "waiting") {
		return (
			<Badge className="border-transparent bg-amber-500/15 text-amber-600 dark:bg-amber-400/15 dark:text-amber-400">
				Waiting on you
			</Badge>
		);
	}

	if (status === "working") {
		return (
			<span className="inline-flex items-center gap-1.5">
				<StatusIndicator status="working" />
				<span className="text-xs text-muted-foreground">Working</span>
			</span>
		);
	}

	// idle — StatusIndicator has no "idle" variant, so use a plain static dot.
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
			<span className="text-xs text-muted-foreground">Idle</span>
		</span>
	);
}
