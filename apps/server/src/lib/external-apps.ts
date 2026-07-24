import { spawn } from "node:child_process";
import nodePath from "node:path";
import type { ExternalApp } from "@superset/local-db";

/**
 * Server port of the desktop's external/helpers.ts path-cleanup utilities
 * (stripPathWrappers/resolvePath) plus a platform-aware command resolver.
 * Desktop only ever resolves macOS `open -a`/`open -b` commands; the server
 * also runs on Windows/Linux, so app launching is resolved per-platform here.
 */

/** CLI shim names for editors that install one on PATH. Windows: JetBrains
 * Toolbox "Generate Shell Scripts" produces these lowercase, unsuffixed names;
 * VS Code/Cursor/Sublime/Zed installers add their own shims the same way. */
const WINDOWS_CLI: Partial<Record<ExternalApp, string>> = {
	vscode: "code",
	"vscode-insiders": "code-insiders",
	cursor: "cursor",
	antigravity: "antigravity",
	zed: "zed",
	sublime: "subl",
	warp: "warp",
	ghostty: "ghostty",
	intellij: "idea",
	webstorm: "webstorm",
	pycharm: "pycharm",
	phpstorm: "phpstorm",
	rubymine: "rubymine",
	goland: "goland",
	clion: "clion",
	rider: "rider",
	datagrip: "datagrip",
	fleet: "fleet",
	rustrover: "rustrover",
};

/** Apps with no Windows/Linux equivalent (macOS-only tools). */
const MACOS_ONLY: ReadonlySet<ExternalApp> = new Set([
	"xcode",
	"iterm",
	"appcode",
]);

const MACOS_APP_NAMES: Partial<Record<ExternalApp, string>> = {
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
	webstorm: "WebStorm",
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

const MACOS_BUNDLE_ID_CANDIDATES: Partial<Record<ExternalApp, string[]>> = {
	intellij: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
	pycharm: ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
};

export interface Command {
	command: string;
	args: string[];
}

/**
 * Resolve candidate commands to launch `app` on the current OS. Returns
 * `null` when the app has no known launcher on this platform (caller should
 * surface a clear "not supported here" error rather than spawn blindly).
 */
export function getAppCommand(
	app: ExternalApp,
	targetPath: string,
): Command[] | null {
	if (process.platform === "darwin") {
		const bundleIds = MACOS_BUNDLE_ID_CANDIDATES[app];
		if (bundleIds) {
			return bundleIds.map((id) => ({
				command: "open",
				args: ["-b", id, targetPath],
			}));
		}
		const appName = MACOS_APP_NAMES[app];
		if (!appName) return null;
		return [{ command: "open", args: ["-a", appName, targetPath] }];
	}

	if (MACOS_ONLY.has(app)) return null;

	if (process.platform === "win32") {
		const shim = WINDOWS_CLI[app];
		if (!shim) return null;
		return [{ command: shim, args: [targetPath] }];
	}

	// Linux and other platforms: try the bare CLI shim if we know one.
	const shim = WINDOWS_CLI[app];
	if (!shim) return null;
	return [{ command: shim, args: [targetPath] }];
}

/** Reveal (and select, where supported) a path in the OS file manager. */
export function getRevealCommand(targetPath: string): Command {
	if (process.platform === "win32") {
		return { command: "explorer", args: [`/select,${targetPath}`] };
	}
	if (process.platform === "darwin") {
		return { command: "open", args: ["-R", targetPath] };
	}
	return { command: "xdg-open", args: [nodePath.dirname(targetPath)] };
}

/**
 * Reveal a path in the OS file manager. `explorer.exe /select,` reliably
 * exits with code 1 even on success (a long-standing Windows quirk), so this
 * doesn't go through spawnAsync's exit-code check on that platform.
 */
export function revealInFileManager(targetPath: string): Promise<void> {
	const { command, args } = getRevealCommand(targetPath);

	if (process.platform === "win32") {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				stdio: ["ignore", "ignore", "ignore"],
			});
			child.on("error", (error) =>
				reject(
					new Error(`Failed to spawn 'explorer': ${error.message}`),
				),
			);
			child.on("exit", () => resolve());
		});
	}

	return spawnAsync(command, args);
}

/** Open a URL/path with the OS-registered default handler. */
export function getOpenCommand(target: string): Command {
	if (process.platform === "win32") {
		// cmd's `start` treats the first quoted arg as the window title, so an
		// empty title must precede the target.
		return { command: "cmd", args: ["/c", "start", '""', target] };
	}
	if (process.platform === "darwin") {
		return { command: "open", args: [target] };
	}
	return { command: "xdg-open", args: [target] };
}

/** Copy text to the OS clipboard via the platform's CLI pipe. */
export function copyToClipboard(text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const { command, args } =
			process.platform === "win32"
				? { command: "clip", args: [] as string[] }
				: process.platform === "darwin"
					? { command: "pbcopy", args: [] as string[] }
					: { command: "xclip", args: ["-selection", "clipboard"] };

		const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", (error) =>
			reject(new Error(`Failed to copy to clipboard: ${error.message}`)),
		);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `clipboard write exited ${code}`));
		});
		child.stdin?.end(text);
	});
}

/**
 * Wrapper characters that can surround paths, and trailing sentence
 * punctuation — ported verbatim from the desktop helpers (pure logic, no
 * Electron dependency).
 */
const PATH_WRAPPERS: [string, string][] = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["(", ")"],
	["[", "]"],
	["<", ">"],
];

const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function looksLikePath(str: string): boolean {
	return (
		str.includes("/") ||
		str.startsWith(".") ||
		str.startsWith("~") ||
		str.startsWith("/")
	);
}

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

function stripTrailingPunctuation(path: string): string {
	const match = path.match(TRAILING_PUNCTUATION);
	if (!match) return path;

	const punct = match[0];
	const beforePunct = path.slice(0, -punct.length);

	if (punct === "." || punct.startsWith(".")) {
		const extMatch = beforePunct.match(/\.[a-zA-Z0-9]{1,10}$/);
		if (extMatch) {
			return beforePunct;
		}
		if (/^\.[a-zA-Z0-9]{1,10}\.$/.test(punct)) {
			return path.slice(0, -1);
		}
	}

	if (punct === ":") {
		return beforePunct;
	}
	if (punct.startsWith(":") && /^:\d/.test(punct)) {
		return path;
	}

	return beforePunct;
}

export function stripPathWrappers(filePath: string): string {
	let result = filePath.trim();

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

export function resolvePath(filePath: string, cwd?: string): string {
	let resolved = stripPathWrappers(filePath);

	if (resolved.startsWith("file://")) {
		try {
			const url = new URL(resolved);
			resolved = decodeURIComponent(url.pathname);
		} catch {
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
			shell: process.platform === "win32",
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
