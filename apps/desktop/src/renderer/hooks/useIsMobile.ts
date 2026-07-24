import { useSyncExternalStore } from "react";

/**
 * Mobile breakpoint (PHASE_3 §3 responsive layout). Below this width the
 * chrome reflows for phones: workspace rail becomes a drawer, the right
 * sidebar becomes a bottom sheet, and terminals grow an on-screen key bar.
 * Matches Tailwind's `md` boundary so CSS (`max-md:*`) and JS agree.
 */
export const MOBILE_BREAKPOINT_PX = 768;

const QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`;

function subscribe(onStoreChange: () => void): () => void {
	const mql = window.matchMedia(QUERY);
	mql.addEventListener("change", onStoreChange);
	return () => mql.removeEventListener("change", onStoreChange);
}

function getSnapshot(): boolean {
	return window.matchMedia(QUERY).matches;
}

/** Reactive: true when the viewport is phone-sized. */
export function useIsMobile(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Imperative check for non-React code paths. */
export function isMobileViewport(): boolean {
	return typeof window !== "undefined" && window.matchMedia(QUERY).matches;
}
