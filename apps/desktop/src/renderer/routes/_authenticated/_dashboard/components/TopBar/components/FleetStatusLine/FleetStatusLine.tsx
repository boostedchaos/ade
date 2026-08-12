import { cn } from "@superset/ui/utils";
import { useFleetStatus } from "renderer/hooks/useFleetStatus";

/**
 * The titlebar's live status line — `1 working  1 waiting` (DESIGN-BRIEF §2a).
 *
 * These are the brief's 5px dots, deliberately NOT irises. The iris is a
 * per-agent object; this is a tally across the fleet, and shrinking a 14px
 * ring to 5px would render as an indistinct smudge at exactly the size where
 * the ring and the pupil merge.
 */
export function FleetStatusLine({ className }: { className?: string }) {
	const { working, waiting } = useFleetStatus();

	if (working === 0 && waiting === 0) return null;

	return (
		<div
			className={cn("no-drag flex items-center gap-4 font-mono", className)}
			style={{ fontSize: "var(--argus-size-chip)" }}
		>
			{working > 0 && (
				<span
					className="flex items-center gap-2"
					style={{ color: "var(--argus-text-secondary)" }}
				>
					<Dot color="var(--argus-iris-working)" />
					{working} working
				</span>
			)}
			{waiting > 0 && (
				<span
					className="flex items-center gap-2"
					style={{ color: "var(--argus-text-secondary)" }}
				>
					<Dot color="var(--argus-iris-waiting)" />
					{waiting} waiting
				</span>
			)}
		</div>
	);
}

function Dot({ color }: { color: string }) {
	return (
		<span
			className="inline-block shrink-0 rounded-full"
			style={{ width: 5, height: 5, backgroundColor: color }}
		/>
	);
}
