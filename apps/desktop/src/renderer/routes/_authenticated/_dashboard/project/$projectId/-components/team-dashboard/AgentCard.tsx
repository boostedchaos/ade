import { Avatar, AvatarFallback, AvatarImage } from "@superset/ui/avatar";
import { cn } from "@superset/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { navigateToWorkspace } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import { AgentStatusBadge } from "./AgentStatusBadge";
import type { ChecksStatus, RosterEntry } from "./types";

/** "claude-opus-4-8" / "claude-sonnet-4-5-20250929" -> "opus-4-8" / "sonnet-4-5". */
function shortModelName(model: string): string {
	return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/** Raw token count, never a percentage — transcripts don't record the window size. */
function formatTokens(tokens: number): string {
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const CHECKS_DOT: Record<ChecksStatus, string> = {
	success: "bg-emerald-500",
	failure: "bg-destructive",
	pending: "bg-amber-500",
	none: "bg-muted-foreground/40",
};

function sessionLine(session: RosterEntry["session"]): string | null {
	if (!session) return null;
	const parts: string[] = [];
	if (session.model) parts.push(shortModelName(session.model));
	if (session.contextTokens != null) parts.push(formatTokens(session.contextTokens));
	return parts.length > 0 ? parts.join(" · ") : null;
}

interface AgentCardProps {
	entry: RosterEntry;
	/** GitHub PR overlay still loading (issue #65): reserve the PR slot so the
	 * badge hydrating in later causes no layout shift. */
	prPending?: boolean;
}

export function AgentCard({ entry, prPending }: AgentCardProps) {
	const navigate = useNavigate();
	const session = sessionLine(entry.session);

	return (
		<button
			type="button"
			onClick={() => navigateToWorkspace(entry.workspaceId, navigate)}
			className={cn(
				"flex w-full flex-col gap-2 rounded-xl border bg-card p-3 text-left",
				"transition-colors hover:bg-accent/50 focus-visible:outline-none",
				"focus-visible:ring-[3px] focus-visible:ring-ring/50",
			)}
		>
			<div className="flex items-start gap-2.5">
				<Avatar className="size-8">
					{entry.iconUrl && <AvatarImage src={entry.iconUrl} alt={entry.name} />}
					<AvatarFallback className="text-xs font-medium">
						{initials(entry.name)}
					</AvatarFallback>
				</Avatar>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="truncate text-sm font-medium text-foreground">
						{entry.name}
					</span>
					{entry.branch && (
						<span className="truncate font-mono text-[11px] leading-none text-muted-foreground">
							{entry.branch}
						</span>
					)}
				</div>
			</div>

			<div className="flex items-center justify-between gap-2">
				<AgentStatusBadge status={entry.status} />
				{entry.pr ? (
					<span className="flex items-center gap-1 text-[11px] text-muted-foreground">
						<span
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								CHECKS_DOT[entry.pr.checksStatus],
							)}
						/>
						<span className="font-mono tabular-nums">#{entry.pr.number}</span>
					</span>
				) : prPending ? (
					// Reserve the PR slot while the GitHub overlay resolves so the
					// badge hydrating in later doesn't shift the row (issue #65).
					<span
						aria-hidden
						className="flex items-center gap-1 text-[11px] text-muted-foreground/50"
					>
						<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground/20" />
						<span className="font-mono tabular-nums opacity-0">#0000</span>
					</span>
				) : null}
			</div>

			{session && (
				<span className="truncate text-[11px] leading-none text-muted-foreground tabular-nums">
					{session}
				</span>
			)}
		</button>
	);
}
