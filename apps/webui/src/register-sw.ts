// Register the PWA service worker (app-shell caching + offline page).
// Only in production builds served over http(s) — the dev server has none.
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
	window.addEventListener("load", () => {
		navigator.serviceWorker.register("/service-worker.js").catch(() => {
			// Non-fatal: the app works without offline support.
		});
	});
}
