/**
 * ADE service worker (PHASE_3.md §2).
 *
 * Caches the app shell for instant launch on the phone; NETWORK-ONLY for
 * /trpc (never cache API or subscriptions). On network failure for a
 * navigation, show a minimal offline page rather than a broken UI.
 */
const SHELL_CACHE = "ade-shell-v1";
const OFFLINE_HTML =
	'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADE — offline</title><body style="font-family:system-ui;background:#252525;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>ADE server unreachable</h1><p>Reconnect to the network running ade-server, then reload.</p></div></body>';

self.addEventListener("install", (event) => {
	self.skipWaiting();
	event.waitUntil(
		caches
			.open(SHELL_CACHE)
			.then((cache) => cache.addAll(["/", "/manifest.webmanifest"]))
			.catch(() => {}),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const { request } = event;
	const url = new URL(request.url);

	// Never intercept the API or websockets.
	if (url.pathname.startsWith("/trpc")) return;
	if (request.method !== "GET") return;

	// Navigations: network-first, fall back to cached shell, then offline page.
	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request)
				.then((res) => {
					const copy = res.clone();
					caches.open(SHELL_CACHE).then((c) => c.put("/", copy)).catch(() => {});
					return res;
				})
				.catch(async () => {
					const cached = await caches.match("/");
					return (
						cached ??
						new Response(OFFLINE_HTML, {
							headers: { "content-type": "text/html; charset=utf-8" },
						})
					);
				}),
		);
		return;
	}

	// Hashed assets: cache-first (content-addressed, safe to cache forever).
	event.respondWith(
		caches.match(request).then(
			(cached) =>
				cached ??
				fetch(request).then((res) => {
					if (res.ok && url.origin === self.location.origin) {
						const copy = res.clone();
						caches.open(SHELL_CACHE).then((c) => c.put(request, copy)).catch(() => {});
					}
					return res;
				}),
		),
	);
});
