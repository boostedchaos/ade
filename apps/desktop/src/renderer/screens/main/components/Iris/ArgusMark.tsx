import { cn } from "@superset/ui/utils";

/**
 * The Argus app mark — the same iris object with an added outer ring.
 *
 * The mark simplifies as it shrinks (DESIGN-BRIEF.md "The iris", board 5c):
 * below 20px the outer ring is dropped and the pupil grows, because at small
 * sizes three concentric strokes turn into grey mush.
 *
 * | rendered size | outer ring | iris ring        | pupil |
 * | ---           | ---        | ---              | ---   |
 * | > 20px        | r=31       | r=14  stroke 2.5 | r=4.5 |
 * | 17-20px       | dropped    | r=26  stroke 7   | r=9   |
 * | <= 16px       | dropped    | r=24  stroke 9   | r=10  |
 *
 * All three are drawn on the same 72 viewBox, so the mark keeps its optical
 * weight across the ladder. Never rotate it; never fill the outer ring.
 */

interface ArgusMarkProps {
	/** Rendered size in px. Picks the variant off the ladder above. */
	size?: number;
	/**
	 * `mono` collapses the mark to a single color — for the tray template
	 * image and anywhere the mark sits on an unknown background.
	 */
	tone?: "color" | "mono";
	className?: string;
	/** Set when adjacent text already says "Argus". */
	decorative?: boolean;
}

export function ArgusMark({
	size = 72,
	tone = "color",
	className,
	decorative = false,
}: ArgusMarkProps) {
	const irisColor =
		tone === "mono"
			? "var(--argus-text-emphasis)"
			: "var(--argus-iris-working)";
	const outerColor = "var(--argus-iris-idle)";

	const a11y = decorative
		? ({ "aria-hidden": true } as const)
		: ({ role: "img", "aria-label": "Argus" } as const);

	const variant = size > 20 ? "full" : size > 16 ? "small" : "mono";

	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 72 72"
			fill="none"
			className={cn("shrink-0", className)}
			{...a11y}
		>
			<title>Argus</title>
			{variant === "full" && (
				<>
					<circle
						cx="36"
						cy="36"
						r="31"
						stroke={outerColor}
						strokeWidth="1"
						fill="none"
					/>
					<circle
						cx="36"
						cy="36"
						r="14"
						stroke={irisColor}
						strokeWidth="2.5"
						fill="none"
					/>
					<circle cx="36" cy="36" r="4.5" fill={irisColor} />
				</>
			)}

			{variant === "small" && (
				<>
					<circle
						cx="36"
						cy="36"
						r="26"
						stroke={irisColor}
						strokeWidth="7"
						fill="none"
					/>
					<circle cx="36" cy="36" r="9" fill={irisColor} />
				</>
			)}

			{variant === "mono" && (
				<>
					<circle
						cx="36"
						cy="36"
						r="24"
						stroke={irisColor}
						strokeWidth="9"
						fill="none"
					/>
					<circle cx="36" cy="36" r="10" fill={irisColor} />
				</>
			)}
		</svg>
	);
}

/**
 * Mark + wordmark lockup.
 *
 * Clear space is one ring diameter and the wordmark never goes below 96px —
 * both are enforced here rather than left to each caller.
 */
interface ArgusLockupProps {
	/** Mark size in px; the wordmark and gap scale from it. */
	markSize?: number;
	/** Wordmark size in px. */
	wordmarkSize?: number;
	/** Display sizes widen the tracking from .42em to .46em. */
	display?: boolean;
	className?: string;
}

export function ArgusLockup({
	markSize = 18,
	wordmarkSize = 14,
	display = false,
	className,
}: ArgusLockupProps) {
	return (
		<div className={cn("flex items-center", className)}>
			<ArgusMark size={markSize} decorative />
			<span
				className={cn(
					"argus-wordmark",
					display && "argus-wordmark-display",
					"text-foreground",
				)}
				style={{
					fontSize: wordmarkSize,
					// Clear space = one ring diameter (DESIGN-BRIEF.md "The iris").
					marginInlineStart: markSize,
				}}
			>
				Argus
			</span>
		</div>
	);
}
