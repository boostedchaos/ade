import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import nodePath from "node:path";
import type { ExternalApp } from "@superset/local-db";

/** Map of app IDs to their macOS application names */
const APP_NAMES: Record<ExternalApp, string | null> = {
	finder: null, // Handled specially with shell.showItemInFolder
	vscode: "Visual Studio Code",
	"vscode-insiders": "Visual Studio Code - Insiders",
	cursor: "Cursor",
	antigravity: "Antigravity",
	zed: "Zed",
	xcode: "Xcode",
	iterm: "iTerm",
	warp: "Warp",
	terminal: "Terminal",
	ghostty: "Ghostty",
	sublime: "Sublime Text",
	intellij: null, // Multi-edition, uses bundle IDs
	webstorm: "WebStorm",
	pycharm: null, // Multi-edition, uses bundle IDs
	phpstorm: "PhpStorm",
	rubymine: "RubyMine",
	goland: "GoLand",
	clion: "CLion",
	rider: "Rider",
	datagrip: "DataGrip",
	appcode: "AppCode",
	fleet: "Fleet",
	rustrover: "RustRover",
};

/**
 * Bundle ID candidates for JetBrains IDEs with multiple editions.
 * `open -b <bundleId>` works regardless of the .app display name,
 * so "IntelliJ IDEA Ultimate.app" and "IntelliJ IDEA CE.app" both resolve correctly.
 */
const BUNDLE_ID_CANDIDATES: Partial<Record<ExternalApp, string[]>> = {
	intellij: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
	pycharm: ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
};

/**
 * Windows editor CLI shims. These are the launchers installers place on PATH
 * (`code.cmd`, `cursor.cmd`, `subl.exe`, …). Apps with no Windows CLI are
 * absent — the caller then falls back to Electron's `shell.openPath`, which
 * opens the file with the OS default handler.
 */
const WIN32_CLI_SHIMS: Partial<Record<ExternalApp, string>> = {
	vscode: "code",
	"vscode-insiders": "code-insiders",
	cursor: "cursor",
	antigravity: "antigravity",
	zed: "zed",
	sublime: "subl",
};

/**
 * Resolve an executable/shim name to its full path via PATH + PATHEXT.
 * Windows shims are often `.cmd`/`.bat`, which Node cannot spawn directly, so
 * callers must know the real extension. Returns null if not found on PATH.
 */
function resolveOnPath(name: string): string | null {
	const pathEnv = process.env.PATH || process.env.Path || "";
	const dirs = pathEnv.split(nodePath.delimiter).filter(Boolean);
	const isWin = process.platform === "win32";
	const exts = isWin
		? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
				.split(";")
				.map((e) => e.trim())
				.filter(Boolean)
		: [""];

	for (const dir of dirs) {
		// name may already carry an extension
		const asIs = nodePath.join(dir, name);
		if (existsSync(asIs)) return asIs;
		for (const ext of exts) {
			const candidate = nodePath.join(dir, name + ext);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

/**
 * Windows variant of getAppCommand. Resolves the editor's CLI shim on PATH and,
 * because `.cmd`/`.bat` shims cannot be spawned directly by Node, routes those
 * through `cmd.exe /d /s /c`. Returns null (→ shell.openPath fallback) when the
 * app has no Windows CLI or its shim isn't installed.
 */
function getWin32AppCommand(
	app: ExternalApp,
	targetPath: string,
): { command: string; args: string[] }[] | null {
	const shim = WIN32_CLI_SHIMS[app];
	if (!shim) return null;

	const resolved = resolveOnPath(shim);
	if (!resolved) return null;

	const ext = nodePath.extname(resolved).toLowerCase();
	if (ext === ".cmd" || ext === ".bat") {
		return [
			{
				command: process.env.COMSPEC || "cmd.exe",
				args: ["/d", "/s", "/c", resolved, targetPath],
			},
		];
	}
	return [{ command: resolved, args: [targetPath] }];
}

/**
 * Get candidate commands to open a path in the specified app.
 * Returns an array of commands to try in order — for multi-edition apps (IntelliJ, PyCharm),
 * multiple bundle IDs are returned so the caller can fall back if one isn't installed.
 * Uses `open -b` (bundle ID) for multi-edition apps and `open -a` (app name) for others.
 * On Windows, resolves editor CLI shims on PATH (see getWin32AppCommand).
 */
export function getAppCommand(
	app: ExternalApp,
	targetPath: string,
): { command: string; args: string[] }[] | null {
	if (process.platform === "win32") {
		return getWin32AppCommand(app, targetPath);
	}

	const bundleIds = BUNDLE_ID_CANDIDATES[app];
	if (bundleIds) {
		return bundleIds.map((id) => ({
			command: "open",
			args: ["-b", id, targetPath],
		}));
	}

	const appName = APP_NAMES[app];
	if (!appName) return null;
	return [{ command: "open", args: ["-a", appName, targetPath] }];
}

/**
 * Wrapper characters that can surround paths.
 * These are pairs of [open, close] characters.
 */
const PATH_WRAPPERS: [string, string][] = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["(", ")"],
	["[", "]"],
	["<", ">"],
];

/**
 * Trailing punctuation that can appear after paths in sentences.
 * These are stripped unless they're part of a valid suffix (extension, line:col).
 */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Check if a string looks like a file path.
 * A path typically contains a separator (`/` or Windows `\`), a drive-letter
 * prefix (`C:\`, `C:/`), or starts with ., ~, or /.
 */
export function looksLikePath(str: string): boolean {
	return (
		str.includes("/") ||
		str.includes("\\") ||
		/^[a-zA-Z]:[\\/]/.test(str) ||
		str.startsWith(".") ||
		str.startsWith("~") ||
		str.startsWith("/")
	);
}

/**
 * Extract a path from within brackets/parentheses when there's adjacent text.
 * Handles patterns like:
 *   "text(src/file.ts)more" -> "src/file.ts"
 *   "see (path/to/file) here" -> "path/to/file"
 *   "in [src/file.ts:42]" -> "src/file.ts:42"
 *
 * Returns the original string if no embedded path is found.
 */
function extractEmbeddedPath(input: string): string {
	const bracketPairs: [string, string][] = [
		["(", ")"],
		["[", "]"],
		["<", ">"],
	];

	for (const [open, close] of bracketPairs) {
		const openIdx = input.indexOf(open);
		const closeIdx = input.lastIndexOf(close);

		if (openIdx !== -1 && closeIdx > openIdx) {
			const hasTextBefore = openIdx > 0;
			const hasTextAfter = closeIdx < input.length - 1;

			if (hasTextBefore || hasTextAfter) {
				const content = input.slice(openIdx + 1, closeIdx);
				if (looksLikePath(content)) {
					return content;
				}
			}
		}
	}

	return input;
}

/**
 * Strip trailing punctuation from a path, but preserve valid suffixes.
 * - Preserves file extensions like .ts, .json
 * - Preserves line:col suffixes like :42 or :42:10
 * - Strips sentence punctuation like trailing period, comma, etc.
 */
function stripTrailingPunctuation(path: string): string {
	const match = path.match(TRAILING_PUNCTUATION);
	if (!match) return path;

	const punct = match[0];
	const beforePunct = path.slice(0, -punct.length);

	// Don't strip if it looks like a file extension (e.g., "file.ts")
	if (punct === "." || punct.startsWith(".")) {
		const extMatch = beforePunct.match(/\.[a-zA-Z0-9]{1,10}$/);
		if (extMatch) {
			return beforePunct;
		}
		// e.g., path ends with ".ts." - strip just the final "."
		if (/^\.[a-zA-Z0-9]{1,10}\.$/.test(punct)) {
			return path.slice(0, -1);
		}
	}

	// Don't strip colons followed by digits (line numbers like :42)
	if (punct === ":") {
		return beforePunct;
	}
	if (punct.startsWith(":") && /^:\d/.test(punct)) {
		return path;
	}

	return beforePunct;
}

/**
 * Strip matching wrapper characters and trailing punctuation from a path.
 * Handles nested wrappers and multiple layers of wrapping.
 * Examples:
 *   "(path/to/file)" -> "path/to/file"
 *   '"path/to/file"' -> "path/to/file"
 *   "'(path/to/file)'" -> "path/to/file"
 *   "./path/file.ts." -> "./path/file.ts"
 *   '"./path/file.ts",' -> "./path/file.ts"
 *   "path/to/file" -> "path/to/file" (unchanged)
 */
export function stripPathWrappers(filePath: string): string {
	let result = filePath.trim();

	// First, try to extract embedded paths from patterns like "text(path)more"
	result = extractEmbeddedPath(result);

	let changed = true;
	while (changed && result.length > 0) {
		changed = false;

		const withoutPunct = stripTrailingPunctuation(result);
		if (withoutPunct !== result) {
			result = withoutPunct;
			changed = true;
			continue;
		}

		for (const [open, close] of PATH_WRAPPERS) {
			if (result.startsWith(open) && result.endsWith(close)) {
				result = result.slice(1, -1);
				changed = true;
				break;
			}
		}
	}

	return result;
}

/**
 * Resolve a path by expanding ~ and converting relative paths to absolute.
 * Also handles file:// URLs by converting them to regular file paths.
 * Strips wrapping characters like quotes, parentheses, brackets, etc.
 */
export function resolvePath(filePath: string, cwd?: string): string {
	let resolved = stripPathWrappers(filePath);

	if (resolved.startsWith("file://")) {
		try {
			const url = new URL(resolved);
			resolved = decodeURIComponent(url.pathname);
		} catch {
			// If URL parsing fails, try simple prefix removal
			resolved = decodeURIComponent(resolved.replace(/^file:\/\//, ""));
		}
	}

	if (resolved.startsWith("~")) {
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home) {
			resolved = resolved.replace(/^~/, home);
		}
	}

	if (!nodePath.isAbsolute(resolved)) {
		resolved = cwd
			? nodePath.resolve(cwd, resolved)
			: nodePath.resolve(resolved);
	}

	return resolved;
}

/**
 * Spawns a process and waits for it to complete.
 * @throws Error if the process exits with non-zero code or fails to spawn
 */
export function spawnAsync(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "ignore", "pipe"],
			detached: false,
		});

		let stderr = "";
		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("error", (error) => {
			reject(
				new Error(
					`Failed to spawn '${command}': ${error.message}. Ensure the application is installed.`,
				),
			);
		});

		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
			} else {
				const stderrMessage = stderr.trim();
				reject(
					new Error(stderrMessage || `'${command}' exited with code ${code}`),
				);
			}
		});
	});
}

export type { ExternalApp };
