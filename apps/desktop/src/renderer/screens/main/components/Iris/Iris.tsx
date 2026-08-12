import { cn } from "@superset/ui/utils";
import { useEffect, useRef, useState } from "react";
import type { PaneStatus } from "shared/tabs-types";

/**
 * The iris — Argus's one idea.
 *
 * An open ring with a pupil is simultaneously the app mark and the per-agent
 * status indicator. It replaces every status dot, avatar and badge in the app.
 *
 * Geometry (DESIGN-BRIEF.md "The iris"): 14x14 viewBox, outer ring r=6,
 * pupil r=2, stroke 1.
 *
 * Rules that hold everywhere: never rotate it, never fill the outer ring,
 * clear space is one ring diameter.
 */

export type IrisState = "working" | "waiting" | "review" | "idle" | "detached";

/**
 * The app's PaneStatus does not line up with the brief's four states — the
 * brief has no `review`, and the app has no `detached`. SPEC.md §Rulings 1
 * settles the mapping; this is that table in code.
 *
 * Note the deliberate color reassignment it forces: pre-Argus, `working` was
 * amber and `permission` was red. Under Argus, working is blue and waiting is
 * amber. That is intended, not a mistake.
 */
export const PANE_STATUS_TO_IRIS = {
	working: "working",
	permission: "waiting",
	review: "review",
	idle: "idle",
} as const satisfies Record<PaneStatus, IrisState>;

export function irisStateForPaneStatus(status: PaneStatus): IrisState {
	return PANE_STATUS_TO_IRIS[status];
}

interface IrisStateConfig {
	/** CSS custom property for the ring stroke. */
	stroke: string;
	/** Pupil fill, or null for the states that have no pupil. */
	pupil: string | null;
	dashed: boolean;
	label: string;
}

const IRIS_CONFIG = {
	working: {
		stroke: "var(--argus-iris-working)",
		pupil: "var(--argus-iris-working)",
		dashed: false,
		label: "Working",
	},
	waiting: {
		stroke: "var(--argus-iris-waiting)",
		pupil: "var(--argus-iris-waiting)",
		dashed: false,
		label: "Waiting on you",
	},
	review: {
		stroke: "var(--argus-iris-review)",
		pupil: null,
		dashed: false,
		label: "Ready for review",
	},
	idle: {
		stroke: "var(--argus-iris-idle)",
		pupil: null,
		dashed: false,
		label: "Idle",
	},
	// Built but not fed: nothing in the app tracks "daemon alive, UI
	// disconnected" yet. SPEC.md §Rulings 2 defers the wiring and records the
	// trigger for implementing it. The state exists so it is drawable.
	detached: {
		stroke: "var(--argus-iris-idle)",
		pupil: null,
		dashed: true,
		label: "Detached",
	},
} as const satisfies Record<IrisState, IrisStateConfig>;

export function getIrisLabel(state: IrisState): string {
	return IRIS_CONFIG[state].label;
}

interface IrisProps {
	state: IrisState;
	/** Rendered size in px. The geometry is a 14px viewBox scaled to this. */
	size?: number;
	/**
	 * Pulse the attention ring. Only meaningful for `waiting`; the animation
	 * itself runs exactly three times and stops (see globals.css).
	 */
	pulse?: boolean;
	className?: string;
	/**
	 * Set when a neighbouring element already names the state in text, so the
	 * iris does not repeat it to a screen reader.
	 */
	decorative?: boolean;
}

/**
 * True only for a state change that happened while this iris was already on
 * screen — never on the first render.
 *
 * This is what keeps the wake animation honest. "Nothing animates on load" is
 * one of the brief's non-negotiables, and the naive implementation (put the
 * animation on the pupil in CSS) breaks it invisibly: every app launch, rail
 * re-render and list scroll would replay the wake on every working agent at
 * once, which looks like a bug and blows the 2-concurrent-animation budget.
 */
function useWokeUp(state: IrisState): boolean {
	const previous = useRef<IrisState | null>(null);
	const [woke, setWoke] = useState(false);

	useEffect(() => {
		const prior = previous.current;
		previous.current = state;
		// First render: record the state, animate nothing.
		if (prior === null) return;
		if (prior === state) return;
		// The wake movement is specifically idle -> working (a pupil appearing).
		const gainedPupil =
			IRIS_CONFIG[state].pupil !== null && IRIS_CONFIG[prior].pupil === null;
		if (!gainedPupil) return;

		setWoke(true);
		const timer = setTimeout(() => setWoke(false), WAKE_DURATION_MS);
		return () => clearTimeout(timer);
	}, [state]);

	return woke;
}

/** Matches --argus-duration-base in globals.css. */
const WAKE_DURATION_MS = 220;

export function Iris({
	state,
	size = 14,
	pulse = false,
	className,
	decorative = false,
}: IrisProps) {
	const config = IRIS_CONFIG[state];
	const woke = useWokeUp(state);
	const a11y = decorative
		? ({ "aria-hidden": true } as const)
		: ({ role: "img", "aria-label": config.label } as const);

	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 14 14"
			fill="none"
			className={cn(
				"shrink-0",
				pulse && state === "waiting" && "argus-iris-attention",
				className,
			)}
			{...a11y}
		>
			<title>{config.label}</title>
			{/* The attention ring: a second ring that expands and fades. Rendered
			    only while pulsing so it costs nothing at rest. */}
			{pulse && state === "waiting" && (
				<circle
					cx="7"
					cy="7"
					r="6"
					stroke={config.stroke}
					strokeWidth="1"
					className="argus-iris-attention-ring"
				/>
			)}
			<circle
				cx="7"
				cy="7"
				r="6"
				stroke={config.stroke}
				strokeWidth="1"
				// Never filled — an open ring is the whole identity.
				fill="none"
				strokeDasharray={config.dashed ? "2 2" : undefined}
				className="argus-iris-ring"
			/>
			{config.pupil && (
				<circle
					cx="7"
					cy="7"
					r="2"
					fill={config.pupil}
					className={cn("argus-iris-pupil", woke && "argus-iris-pupil-wake")}
				/>
			)}
		</svg>
	);
}
