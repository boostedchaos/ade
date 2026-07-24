import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

/**
 * Minimal static file server for the built webui SPA (same origin as /trpc,
 * so the browser client needs no CORS). Unknown paths fall back to
 * index.html for client-side routing. No caching headers yet — the SPA is
 * local-network only; cache tuning is a Phase 4 item.
 */

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json",
	".wasm": "application/wasm",
	".webmanifest": "application/manifest+json",
};

function webuiRoot(): string {
	// Bundled server: dist/server.cjs → webui build lands in dist/webui.
	const bundleSibling =
		typeof __dirname !== "undefined" ? join(__dirname, "webui") : null;
	if (bundleSibling && existsSync(bundleSibling)) return bundleSibling;
	// Monorepo dev: apps/webui/dist.
	return resolve(process.cwd(), "..", "webui", "dist");
}

export function serveStatic(req: IncomingMessage, res: ServerResponse): void {
	const root = webuiRoot();
	const indexPath = join(root, "index.html");
	if (!existsSync(indexPath)) {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end(
			"ade-server: web UI not built. Build apps/webui, or use the API at /trpc.\n",
		);
		return;
	}

	const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
	// Normalize and contain within root (no traversal).
	const requested = normalize(join(root, decodeURIComponent(urlPath)));
	const safe = requested.startsWith(normalize(root));

	let filePath = indexPath;
	if (safe && existsSync(requested) && statSync(requested).isFile()) {
		filePath = requested;
	}

	res.writeHead(200, {
		"content-type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
		// CSP mirrors the desktop renderer's (index.html): xterm's ImageAddon
		// needs 'wasm-unsafe-eval'; terminals/webviews need blob:/data: and
		// ws/wss back to the same origin for tRPC subscriptions.
		"content-security-policy":
			filePath === indexPath
				? "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' data: blob: ws: wss:; img-src 'self' data: blob: https: http:; font-src 'self' data:; frame-src 'self' https: http: data: blob:; child-src 'self' blob:; worker-src 'self' blob:; manifest-src 'self'"
				: "",
	});
	createReadStream(filePath).pipe(res);
}
