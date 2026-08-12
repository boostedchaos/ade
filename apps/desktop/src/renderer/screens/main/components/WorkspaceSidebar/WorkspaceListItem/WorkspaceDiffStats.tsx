import { cn } from "@superset/ui/utils";

interface WorkspaceDiffStatsProps {
	additions: number;
	deletions: number;
	isActive?: boolean;
}

export function WorkspaceDiffStats({
	additions,
	deletions,
	isActive,
}: WorkspaceDiffStatsProps) {
	return (
		<div
			className={cn(
				"flex h-5 shrink-0 items-center rounded px-1.5 text-[10px] font-mono tabular-nums transition-[opacity,visibility] group-hover:opacity-0 group-hover:invisible",
				isActive ? "bg-foreground/10" : "bg-muted/50",
			)}
		>
			<div className="flex items-center gap-1.5 leading-none">
				<span className="text-[var(--argus-pass)]/90">+{additions}</span>
				<span className="text-[var(--destructive)]/90">−{deletions}</span>
			</div>
		</div>
	);
}
