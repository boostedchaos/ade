/**
 * Electron Builder Configuration
 * @see https://www.electron.build/configuration/configuration
 *
 * The default export drives macOS/Linux builds (`bun run package`). The Windows
 * build uses `electron-builder.win.ts`, which calls `createConfig("win")` from
 * this module so the two share everything except native-binary staging. See
 * `scripts/prepare-win-natives.ts` for how win32 binaries are fetched.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Configuration, FileSet } from "electron-builder";
import pkg from "./package.json";

const currentYear = new Date().getFullYear();
const author = pkg.author?.name ?? pkg.author;
const productName = pkg.productName;

// Release repo — single source of truth for where artifacts + update manifests
// are published. TODO(release): confirm GitHub owner/org and set the public repo
// name before publishing. Must stay in sync with RELEASE_REPO_* in
// src/main/lib/auto-updater.ts.
const RELEASE_REPO_OWNER = "per-simmons"; // TODO(release): confirm GitHub owner/org
const RELEASE_REPO_NAME = "damon-ade"; // TODO(release): set public repo name

// Notarize only when Apple credentials are present in the environment
// (CI signing job, or a local signed build). electron-builder reads the
// APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID env vars to run
// notarytool. Unsigned local smoke-test builds leave APPLE_TEAM_ID unset and
// skip notarization automatically.
const notarize = Boolean(process.env.APPLE_TEAM_ID);
const macIconPath = join(pkg.resources, "build/icons/icon.icns");
const linuxIconPath = join(pkg.resources, "build/icons");
const winIconPath = join(pkg.resources, "build/icons/icon.ico");

export type BuildTarget = "default" | "win";

// Native module trees shared by every platform (JS wrappers + their non-binary
// runtime deps). Platform-specific binary packages are added per target below.
const SHARED_NATIVE_FILES: FileSet[] = [
	// better-sqlite3 uses `bindings` package to locate its native .node file
	{
		from: "node_modules/bindings",
		to: "node_modules/bindings",
		filter: ["**/*"],
	},
	// `bindings` requires `file-uri-to-path` for file:// URL handling
	{
		from: "node_modules/file-uri-to-path",
		to: "node_modules/file-uri-to-path",
		filter: ["**/*"],
	},
	// node-pty is the @lydell/node-pty wrapper (platform binary added per target)
	{
		from: "node_modules/node-pty",
		to: "node_modules/node-pty",
		filter: ["**/*"],
	},
	// libsql JS wrapper + loader deps (platform binary package added per target)
	{
		from: "node_modules/libsql",
		to: "node_modules/libsql",
		filter: ["**/*"],
	},
	{
		from: "node_modules/@neon-rs",
		to: "node_modules/@neon-rs",
		filter: ["**/*"],
	},
	{
		from: "node_modules/detect-libc",
		to: "node_modules/detect-libc",
		filter: ["**/*"],
	},
	// friendly-words is a CommonJS module that Vite doesn't bundle
	{
		from: "node_modules/friendly-words",
		to: "node_modules/friendly-words",
		filter: ["**/*"],
	},
];

// macOS/Linux use whatever native binaries `copy:native-modules` materialized
// into node_modules for the host platform.
const DEFAULT_NATIVE_FILES: FileSet[] = [
	{
		from: "node_modules/better-sqlite3",
		to: "node_modules/better-sqlite3",
		filter: ["**/*"],
	},
	...SHARED_NATIVE_FILES,
	// @lydell/node-pty wrapper platform binary (e.g. @lydell/node-pty-darwin-arm64)
	{
		from: "node_modules/@lydell",
		to: "node_modules/@lydell",
		filter: ["**/*"],
	},
	// ast-grep JS wrapper + host platform binary (e.g. @ast-grep/napi-darwin-arm64)
	{
		from: "node_modules/@ast-grep",
		to: "node_modules/@ast-grep",
		filter: ["**/*"],
	},
	// libsql host platform binary (e.g. @libsql/darwin-arm64)
	{
		from: "node_modules/@libsql",
		to: "node_modules/@libsql",
		filter: ["**/*"],
	},
];

// Windows binaries are staged by `scripts/prepare-win-natives.ts` into
// `.win32-natives/` (a sibling of node_modules). Each is mapped to its final
// node_modules location. better-sqlite3 is a full staged COPY so the darwin
// binary the macOS build needs is never clobbered.
const WIN_NATIVE_FILES: FileSet[] = [
	{
		from: ".win32-natives/better-sqlite3",
		to: "node_modules/better-sqlite3",
		filter: ["**/*"],
	},
	...SHARED_NATIVE_FILES,
	// ast-grep JS wrapper (host-agnostic) + the win32 binary package
	{
		from: "node_modules/@ast-grep/napi",
		to: "node_modules/@ast-grep/napi",
		filter: ["**/*"],
	},
	{
		from: ".win32-natives/@lydell/node-pty-win32-x64",
		to: "node_modules/@lydell/node-pty-win32-x64",
		filter: ["**/*"],
	},
	{
		from: ".win32-natives/@ast-grep/napi-win32-x64-msvc",
		to: "node_modules/@ast-grep/napi-win32-x64-msvc",
		filter: ["**/*"],
	},
	{
		from: ".win32-natives/@libsql/win32-x64-msvc",
		to: "node_modules/@libsql/win32-x64-msvc",
		filter: ["**/*"],
	},
];

function buildFiles(target: BuildTarget): Array<string | FileSet> {
	return [
		"dist/**/*",
		"package.json",
		{
			from: pkg.resources,
			to: "resources",
			filter: ["**/*"],
		},
		// Native modules that can't be bundled by Vite.
		// bun creates symlinks for direct deps in workspace node_modules.
		// The copy:native-modules script replaces symlinks with real files
		// before building (required for Bun 1.3+ isolated installs).
		...(target === "win" ? WIN_NATIVE_FILES : DEFAULT_NATIVE_FILES),
		"!**/.DS_Store",
	];
}

export function createConfig(target: BuildTarget = "default"): Configuration {
	const isWin = target === "win";

	return {
		appId: "studio.persimmons.ade",
		productName,
		copyright: `Copyright © ${currentYear} — ${author}`,
		electronVersion: pkg.devDependencies.electron.replace(/^\^/, ""),

		// Generate update manifests for all channels (latest.yml, canary.yml, etc.)
		// This enables proper channel-based auto-updates following electron-builder conventions
		generateUpdatesFilesForAllChannels: true,

		// Publish target for update manifests (latest-mac.yml, etc.). The release
		// workflow uploads artifacts itself (--publish never), but this makes the
		// generated manifests reference the correct public repo.
		publish: {
			provider: "github",
			owner: RELEASE_REPO_OWNER,
			repo: RELEASE_REPO_NAME,
		},

		// Directories
		directories: {
			output: "release",
			buildResources: join(pkg.resources, "build"),
		},

		// ASAR configuration for native modules and external resources
		asar: true,
		asarUnpack: [
			"**/node_modules/better-sqlite3/**/*",
			// better-sqlite3 uses `bindings` to locate native modules - must be unpacked together
			"**/node_modules/bindings/**/*",
			"**/node_modules/file-uri-to-path/**/*",
			"**/node_modules/node-pty/**/*",
			// node-pty (lydell) platform binary packages ship the .node/conpty assets
			"**/node_modules/@lydell/**/*",
			// ast-grep native bindings (package + platform binary package)
			"**/node_modules/@ast-grep/napi*/**/*",
			// libsql native bindings are loaded from @libsql/<platform>
			"**/node_modules/@libsql/**/*",
			// Sound files must be unpacked so external audio players (afplay, paplay, etc.) can access them
			"**/resources/sounds/**/*",
			// Tray icon must be unpacked so Electron Tray can load it
			"**/resources/tray/**/*",
			// Windows tray reads the full-color .ico at runtime from
			// app.asar.unpacked/resources/build/icons (src/main/lib/tray/index.ts)
			"**/resources/build/icons/icon.ico",
			// Windows native binaries are staged from `.win32-natives/` via `files`
			// `from`-mappings into node_modules/<pkg>. electron-builder matches
			// asarUnpack globs against the SOURCE path (relative to the app dir),
			// so the `**/node_modules/...` rules above never match these remapped
			// files — match the staging source instead. Files still unpack to their
			// `to` destination (node_modules/<pkg>/...), so runtime require works.
			"**/.win32-natives/**/*",
		],

		// Extra resources placed outside asar archive (accessible via process.resourcesPath)
		extraResources: [
			// Database migrations - must be outside asar for drizzle-orm to read
			{
				from: "dist/resources/migrations",
				to: "resources/migrations",
				filter: ["**/*"],
			},
		],

		files: buildFiles(target),

		// Rebuild native modules for Electron's Node.js version. Disabled for the
		// Windows build: win32 binaries are prebuilt/staged, never compiled here.
		npmRebuild: !isWin,

		// macOS
		mac: {
			...(existsSync(macIconPath) ? { icon: macIconPath } : {}),
			category: "public.app-category.utilities",
			target: [
				{
					target: "default",
					arch: ["arm64"],
				},
			],
			// Hardened runtime is required for Apple notarization. The entitlements
			// below (allow-jit, allow-unsigned-executable-memory,
			// disable-library-validation) keep Electron + native modules working
			// under the hardened runtime.
			hardenedRuntime: true,
			gatekeeperAssess: false,
			notarize,
			entitlements: join(pkg.resources, "build/entitlements.mac.plist"),
			entitlementsInherit: join(
				pkg.resources,
				"build/entitlements.mac.inherit.plist",
			),
			extendInfo: {
				CFBundleName: productName,
				CFBundleDisplayName: productName,
				// Required for macOS microphone permission prompt
				NSMicrophoneUsageDescription:
					"ADE needs microphone access so voice-enabled tools like Codex transcription can capture audio input.",
				// Required for macOS local network permission prompt
				NSLocalNetworkUsageDescription:
					"ADE needs access to your local network to discover and connect to development servers running on your network.",
				// Bonjour service types to browse for (triggers the permission prompt)
				NSBonjourServices: ["_http._tcp", "_https._tcp"],
				// Required for Apple Events / Automation permission prompt
				NSAppleEventsUsageDescription:
					"ADE needs to interact with other applications to run terminal commands and development tools.",
			},
		},

		// Deep linking protocol
		protocols: {
			name: productName,
			schemes: ["ade"],
		},

		// Linux
		linux: {
			...(existsSync(linuxIconPath) ? { icon: linuxIconPath } : {}),
			category: "Utility",
			synopsis: pkg.description,
			target: ["AppImage"],
			artifactName: `ade-\${version}-\${arch}.\${ext}`,
		},

		// Windows — NSIS installer + portable zip (both x64). Unsigned; the win
		// target only produces artifacts when building with --win.
		win: {
			...(existsSync(winIconPath) ? { icon: winIconPath } : {}),
			target: [
				{
					target: "nsis",
					arch: ["x64"],
				},
				{
					target: "zip",
					arch: ["x64"],
				},
			],
			artifactName: `${productName}-${pkg.version}-\${arch}.\${ext}`,
		},

		// NSIS installer (Windows) — per-user install (no admin), user can choose
		// the install directory, with desktop + start menu shortcuts.
		nsis: {
			oneClick: false,
			perMachine: false,
			allowToChangeInstallationDirectory: true,
			createDesktopShortcut: true,
			createStartMenuShortcut: true,
		},
	};
}

const config = createConfig("default");

export default config;
