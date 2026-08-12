// Apply saved theme class immediately to prevent flash of wrong colors
// This runs before React hydration to ensure correct initial appearance
(() => {
	let themeType;
	try {
		themeType = localStorage.getItem("theme-type");
		document.documentElement.classList.add(
			themeType === "light" ? "light" : "dark",
		);
	} catch (_e) {
		document.documentElement.classList.add("dark");
	}
})();

// Argus chrome geometry differs between macOS and Windows 11 (titlebar height,
// rail width, corner radii - DESIGN-BRIEF.md 2a vs 2b). The values live in
// globals.css under :root.platform-win32; this stamps the class pre-hydration
// so the first paint already has the right geometry.
(() => {
	try {
		const ua = navigator.userAgent;
		const platform = /Windows/i.test(ua)
			? "win32"
			: /Mac OS X|Macintosh/i.test(ua)
				? "darwin"
				: "linux";
		document.documentElement.classList.add(`platform-${platform}`);
	} catch (_e) {
		// Geometry falls back to the macOS values in :root.
	}
})();
