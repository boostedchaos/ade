import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import reactPlugin from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * ADE web UI (PHASE_2.md).
 *
 * Rather than copying the desktop renderer, this app ALIASES into it — the
 * renderer source stays the single source of truth. Only two seams differ
 * from Electron:
 *   1. transport: lib/trpc-client is swapped for the HTTP+WS version
 *   2. the preload surface (window.App/ipcRenderer/webUtils): a web shim
 *      is installed by src/index.tsx before the renderer boots
 */

const rendererRoot = resolve(__dirname, "../desktop/src/renderer");
const desktopSrc = resolve(__dirname, "../desktop/src");

const defineEnv = (value: string | undefined, fallback = "") =>
	JSON.stringify(value ?? fallback);

// The web shell reports the same version as the desktop build it is compiled
// from — the renderer's version check reads it and there is only one renderer.
const appVersion = (
	JSON.parse(
		readFileSync(resolve(__dirname, "../desktop/package.json"), "utf8"),
	) as { version: string }
).version;

export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(appVersion),
		"process.env.NODE_ENV": defineEnv(process.env.NODE_ENV, "production"),
		"process.env.SKIP_ENV_VALIDATION": defineEnv("1"),
		// The web UI runs in a browser — platform-specific UI (shortcut glyphs
		// etc.) keys off the SERVER platform eventually; win32 default for now.
		"process.platform": defineEnv("win32"),
		"process.env.NEXT_PUBLIC_DOCS_URL": defineEnv("https://docs.superset.sh"),
		"process.env.DESKTOP_VITE_PORT": defineEnv(undefined),
		"process.env.DESKTOP_NOTIFICATIONS_PORT": defineEnv(undefined),
		"process.env.ELECTRIC_PORT": defineEnv(undefined),
		"process.env.SUPERSET_WORKSPACE_NAME": defineEnv(undefined),
		"import.meta.env.NEXT_PUBLIC_POSTHOG_KEY": defineEnv(undefined),
		"import.meta.env.NEXT_PUBLIC_POSTHOG_HOST": defineEnv(undefined),
		"import.meta.env.SENTRY_DSN_DESKTOP": defineEnv(undefined),
	},

	resolve: {
		alias: [
			// Transport swap — MUST come before the generic aliases.
			{
				// Matches "renderer/lib/trpc-client", "../../lib/trpc-client" and
				// "./trpc-client" (trpc-storage.ts) — NOT "api-trpc-client".
				find: /^.*\/(lib\/)?trpc-client$/,
				replacement: resolve(__dirname, "src/trpc-client-web.ts"),
			},
			// Desktop tsconfig path aliases, reproduced for the renderer source.
			{ find: /^renderer\//, replacement: `${rendererRoot}/` },
			{ find: /^shared\//, replacement: `${desktopSrc}/shared/` },
			{ find: /^lib\//, replacement: `${desktopSrc}/lib/` },
			{
				find: /^~\/package.json$/,
				replacement: resolve(__dirname, "../desktop/package.json"),
			},
			// xterm packaging bug workaround (same as electron.vite.config.ts)
			{
				find: "@xterm/headless",
				replacement: "@xterm/headless/lib-headless/xterm-headless.js",
			},
		],
	},

	plugins: [
		tanstackRouter({
			target: "react",
			routesDirectory: resolve(rendererRoot, "routes"),
			generatedRouteTree: resolve(rendererRoot, "routeTree.gen.ts"),
			indexToken: "page",
			routeToken: "layout",
			autoCodeSplitting: true,
			routeFileIgnorePattern:
				"^(?!(__root|page|layout)\\.tsx$).*\\.(tsx?|jsx?)$",
		}),
		tailwindcss(),
		reactPlugin(),
	],

	server: {
		port: 5199,
		fs: { allow: [resolve(__dirname, "../..")] },
		proxy: {
			"/trpc": {
				target: "http://127.0.0.1:7777",
				ws: true,
			},
		},
	},

	publicDir: resolve(__dirname, "public"),
	worker: { format: "es" },
	optimizeDeps: { include: ["monaco-editor"] },

	build: {
		sourcemap: true,
		outDir: resolve(__dirname, "dist"),
		rollupOptions: {
			input: { index: resolve(__dirname, "index.html") },
		},
	},
});
