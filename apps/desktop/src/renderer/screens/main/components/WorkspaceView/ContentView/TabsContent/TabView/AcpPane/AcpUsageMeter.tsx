import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import type { AcpCost, AcpUsage } from "./transcript";

/**
 * Context-window usage, as a toolbar chip.
 *
 * `cost` is null on every frame but the turn-final one, so the figure shown
 * is the transcript's retained `lastCost` rather than whatever the newest
 * frame happened to carry.
 */
export function AcpUsageMeter({
	usage,
	lastCost,
}: {
	usage: AcpUsage;
	lastCost: AcpCost;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				{/* A button, not a div: the exact token counts and the session cost
				    live ONLY in the tooltip, so a hover-only trigger puts them out of
				    reach of the keyboard entirely. `type="button"` keeps it out of any
				    enclosing form's submit path. */}
				<button
					className="flex h-6 shrink-0 items-center rounded border border-border/60 px-2 text-muted-foreground text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					type="button"
				>
					{usageLabel(usage)}
				</button>
			</TooltipTrigger>
			<TooltipContent>
				<div>{`${usage.used.toLocaleString()} of ${usage.size.toLocaleString()} tokens`}</div>
				{lastCost && <div>{`${formatCost(lastCost)} session`}</div>}
			</TooltipContent>
		</Tooltip>
	);
}

/** `43.4k / 1M · 4%`. */
export function usageLabel(usage: AcpUsage): string {
	const head = `${formatTokens(usage.used)} / ${formatTokens(usage.size)}`;
	if (usage.size <= 0) return head;
	// Clamped: `used` is the adapter's count against a `size` it reports
	// separately, and the two have no shared source of truth — a compaction or a
	// stale window figure can put used past size, and "104%" of a context window
	// reads as a bug in the pane rather than in the numbers it was handed.
	const percent = Math.min(100, Math.round((usage.used / usage.size) * 100));
	return `${head} · ${percent}%`;
}

/** k/M, one decimal at most, and no trailing `.0`. */
export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${trimTenth(value / 1_000_000)}M`;
	if (value >= 1_000) return `${trimTenth(value / 1_000)}k`;
	return String(value);
}

function trimTenth(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

function formatCost(cost: NonNullable<AcpCost>): string {
	try {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency: cost.currency,
		}).format(cost.amount);
	} catch {
		// An unrecognised ISO 4217 code throws rather than degrading, and a
		// missing cost line is worse than an unformatted one.
		return `${cost.amount.toFixed(2)} ${cost.currency}`;
	}
}
