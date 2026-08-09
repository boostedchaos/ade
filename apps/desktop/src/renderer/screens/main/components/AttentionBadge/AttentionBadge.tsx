import { cn } from "@superset/ui/utils";

/**
 * Unread-attention count (Mission Control Feature 3).
 *
 * Sits alongside StatusIndicator rather than replacing it: the dot says WHAT
 * state a pane is in, this says HOW MANY panes underneath a collapsed thing —
 * a tab, a workspace — are waiting. On a single pane the dot alone is enough,
 * which is why callers only render this when the count is above zero.
 */
interface AttentionBadgeProps {
	count: number;
	className?: string;
	/** Small variant for the tab strip, where vertical space is 40px total. */
	size?: "sm" | "md";
}

export function AttentionBadge({
	count,
	className,
	size = "md",
}: AttentionBadgeProps) {
	if (count <= 0) return null;
	const label = count > 9 ? "9+" : String(count);

	return (
		// <output> rather than a <span role="status">: biome's useSemanticElements
		// asks for the element over the role, and a live region is correct here —
		// the count changes on its own when an agent blocks, so a screen reader
		// should announce it without the user going looking.
		<output
			aria-label={`${count} unread attention notification${count === 1 ? "" : "s"}`}
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-full bg-destructive font-semibold text-destructive-foreground tabular-nums",
				size === "sm"
					? "h-3.5 min-w-3.5 px-1 text-[9px]"
					: "h-4 min-w-4 px-1 text-[10px]",
				className,
			)}
		>
			{label}
		</output>
	);
}
