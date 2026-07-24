import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Compact model + context-usage badge for the ACTIVE session tab (issue #36).
 *
 * Polls `claudeSessions.stats`, which reads the newest Claude Code transcript
 * for the workspace's worktree (`~/.claude/projects/<encoded-cwd>`): the latest
 * assistant turn's `message.model` and `message.usage` token sum. Renders
 * nothing when the worktree has no Claude sessions, so non-Claude runtimes
 * (codex/opencode/...) degrade gracefully to name-only tabs.
 */

/** Poll cadence — the badge only mounts on the active tab, so this is one
 * lightweight tail-read every few seconds per visible workspace. */
const POLL_INTERVAL_MS = 5_000;

/** "claude-opus-4-8" / "claude-sonnet-4-5-20250929" -> "opus-4-8" / "sonnet-4-5". */
function shortModelName(model: string): string {
	return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

interface SessionStatsBadgeProps {
	workspaceId: string;
}

export function SessionStatsBadge({ workspaceId }: SessionStatsBadgeProps) {
	// Cheap: react-query dedupes with GroupStrip's identical workspace query.
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId },
		{ enabled: !!workspaceId },
	);
	const worktreePath = workspace?.worktreePath || "";

	const { data: stats } = electronTrpc.claudeSessions.stats.useQuery(
		{ worktreePath },
		{ enabled: !!worktreePath, refetchInterval: POLL_INTERVAL_MS },
	);

	if (!stats || (!stats.model && stats.contextTokens == null)) return null;

	// Raw token count, not a percentage: transcripts don't record the session's
	// context-window size (200k vs 1M beta), so any % against an assumed window
	// is wrong for 1M sessions — and pins at a capped 100% once past 200k.
	const parts: string[] = [];
	if (stats.model) parts.push(shortModelName(stats.model));
	if (stats.contextTokens != null) parts.push(formatTokens(stats.contextTokens));

	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				<span className="shrink-0 max-w-[80px] truncate text-[10px] leading-none text-muted-foreground tabular-nums">
					{parts.join(" · ")}
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom" showArrow={false}>
				<div className="space-y-0.5">
					{stats.model && <div>Model: {stats.model}</div>}
					{stats.contextTokens != null && (
						<div>Context: ~{formatTokens(stats.contextTokens)} tokens</div>
					)}
					<div className="text-muted-foreground">
						From the newest Claude session in this worktree
					</div>
				</div>
			</TooltipContent>
		</Tooltip>
	);
}
