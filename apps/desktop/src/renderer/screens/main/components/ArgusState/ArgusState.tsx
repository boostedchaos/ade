import { cn } from "@superset/ui/utils";
import type { ReactNode } from "react";

/**
 * The empty & error state grammar (DESIGN-BRIEF.md §8a).
 *
 * Every one of these states is: a 40px icon built from the iris grammar, a
 * 20px weight-300 title, an explanation of at most 420px at 13.5px, an
 * optional mono detail block, and ONE primary action.
 *
 * Defined once so the four quadrants cannot drift apart, and so a fifth state
 * added later inherits the grammar instead of reinventing it.
 */

export type StateTone = "idle" | "error" | "warning";

interface ArgusStateIconProps {
	tone: StateTone;
	/**
	 * The glyph inside the ring. `none` leaves it empty (the dashed idle ring
	 * of "No agents yet"), the others draw the 8a marks.
	 */
	glyph?: "none" | "bang" | "minus" | "cross";
	/** 40px in the full-page states; smaller inside a toast. */
	size?: number;
}

const TONE_COLOR: Record<StateTone, string> = {
	idle: "var(--argus-iris-idle)",
	error: "var(--destructive)",
	warning: "var(--argus-iris-waiting)",
};

/**
 * The state icon IS the iris, at 40px, with the ring carrying the meaning:
 * dashed and empty for "nothing here yet", and a bang / minus / cross for the
 * three failures. It is the same open ring as everywhere else in the app, so
 * an error still looks like Argus rather than like a borrowed icon set.
 */
export function ArgusStateIcon({
	tone,
	glyph = "none",
	size = 40,
}: ArgusStateIconProps) {
	const color = TONE_COLOR[tone];
	// aria-hidden keeps this out of the accessibility tree — the heading beside
	// it is the real label. The <title> is a literal and must be the FIRST child
	// (biome's noSvgWithoutTitle checks that position); it is generic because a
	// per-tone string would surface as a hover tooltip repeating the heading.
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 40 40"
			fill="none"
			aria-hidden
			className="shrink-0"
		>
			<title>Status</title>
			<circle
				cx="20"
				cy="20"
				r="17"
				stroke={color}
				strokeWidth="1"
				fill="none"
				strokeDasharray={glyph === "none" ? "2 3" : undefined}
			/>
			{glyph === "bang" && (
				<>
					<line
						x1="20"
						y1="12"
						x2="20"
						y2="22"
						stroke={color}
						strokeWidth="1.5"
						strokeLinecap="round"
					/>
					<circle cx="20" cy="27" r="1.2" fill={color} />
				</>
			)}
			{glyph === "minus" && (
				<line
					x1="14"
					y1="20"
					x2="26"
					y2="20"
					stroke={color}
					strokeWidth="1.5"
					strokeLinecap="round"
				/>
			)}
			{glyph === "cross" && (
				<>
					<line
						x1="15.5"
						y1="15.5"
						x2="24.5"
						y2="24.5"
						stroke={color}
						strokeWidth="1.5"
						strokeLinecap="round"
					/>
					<line
						x1="24.5"
						y1="15.5"
						x2="15.5"
						y2="24.5"
						stroke={color}
						strokeWidth="1.5"
						strokeLinecap="round"
					/>
				</>
			)}
		</svg>
	);
}

interface ArgusStateProps {
	tone?: StateTone;
	glyph?: ArgusStateIconProps["glyph"];
	title: string;
	/** Kept under 420px by the layout, per the brief. */
	description: ReactNode;
	/** Mono block for a command, a path, a file list. */
	detail?: ReactNode;
	/** ONE primary action. A second competing button is the anti-pattern here. */
	action?: ReactNode;
	/** Quiet text beside the action — a shortcut hint or an auto-retry countdown. */
	actionHint?: ReactNode;
	className?: string;
}

export function ArgusState({
	tone = "idle",
	glyph = "none",
	title,
	description,
	detail,
	action,
	actionHint,
	className,
}: ArgusStateProps) {
	return (
		<div className={cn("flex flex-col items-start", className)}>
			<ArgusStateIcon tone={tone} glyph={glyph} />
			<h2
				className="mt-6"
				style={{
					fontSize: "20px",
					fontWeight: "var(--argus-weight-display)",
					color: "var(--argus-text-active)",
				}}
			>
				{title}
			</h2>
			<div
				className="mt-3"
				style={{
					maxWidth: 420,
					fontSize: "var(--argus-size-body)",
					lineHeight: 1.7,
					color: "var(--argus-text-secondary)",
				}}
			>
				{description}
			</div>
			{detail && (
				<div
					className="mt-5 font-mono"
					style={{
						fontSize: "var(--argus-size-chip)",
						lineHeight: 1.8,
						color: "var(--argus-text-label)",
					}}
				>
					{detail}
				</div>
			)}
			{(action || actionHint) && (
				<div className="mt-6 flex items-center gap-4">
					{action}
					{actionHint && (
						<span
							className="font-mono"
							style={{
								fontSize: "var(--argus-size-chip)",
								color: "var(--argus-text-label)",
							}}
						>
							{actionHint}
						</span>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * The single primary action: a 1px accent-bordered button, 13px/26px padding,
 * 3px radius. Never a filled pill — the app has no pill shapes.
 */
export function ArgusStateAction({
	children,
	onClick,
	tone = "idle",
}: {
	children: ReactNode;
	onClick?: () => void;
	tone?: StateTone;
}) {
	const color =
		tone === "idle" ? "var(--argus-iris-working)" : TONE_COLOR[tone];
	return (
		<button
			type="button"
			onClick={onClick}
			className="transition-colors"
			style={{
				border: `1px solid ${color}`,
				color,
				borderRadius: "var(--argus-radius-surface-lg)",
				padding: "13px 26px",
				fontSize: "var(--argus-size-body-tight)",
			}}
		>
			{children}
		</button>
	);
}
