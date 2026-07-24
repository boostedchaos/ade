/**
 * iOS Safari keyboard shim (PHASE_3 §3): when the software keyboard opens,
 * 100vh does NOT shrink — the focused row and the terminal key bar end up
 * hidden behind the keyboard. Track the visualViewport instead and expose it
 * as --app-height, which globals.css uses to size the app root (falling back
 * to 100vh on desktop, where this module never runs).
 *
 * Also pins the layout viewport to the top: iOS pans the page when focusing
 * inputs near the bottom, which would push the fixed chrome off-screen.
 */
export function installViewportFix(): void {
	const vv = window.visualViewport;
	if (!vv) return;

	let frame: number | null = null;

	const apply = () => {
		frame = null;
		document.documentElement.style.setProperty(
			"--app-height",
			`${Math.round(vv.height)}px`,
		);
		// Counteract iOS auto-panning so the app chrome stays put.
		if (window.scrollY !== 0 || window.scrollX !== 0) {
			window.scrollTo(0, 0);
		}
	};

	const schedule = () => {
		if (frame !== null) return;
		frame = requestAnimationFrame(apply);
	};

	vv.addEventListener("resize", schedule);
	vv.addEventListener("scroll", schedule);
	window.addEventListener("orientationchange", schedule);
	apply();
}

installViewportFix();
