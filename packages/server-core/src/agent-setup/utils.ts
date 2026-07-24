import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { getDefaultShell } from "../terminal/env";

/**
 * Finds all paths for a binary on Unix systems using the login shell.
 */
function findBinaryPathsUnix(name: string): string[] {
	const shell = getDefaultShell();
	const result = execFileSync(
		shell,
		["-l", "-c", 'which -a -- "$1"', "superset-find-binary", name],
		{
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		},
	);
	return result.trim().split("\n").filter(Boolean);
}

/**
 * Finds all paths for a binary on Windows using where.exe.
 */
function findBinaryPathsWindows(name: string): string[] {
	const result = execFileSync("where.exe", [name], {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "ignore"],
	});
	return result.trim().split("\r\n").filter(Boolean);
}

/**
 * Picks the first candidate path that is NOT an ADE wrapper script.
 * Filters out all superset bin directories (prod, dev, and workspace-specific)
 * to avoid wrapper scripts calling each other.
 *
 * Normalizes separators to "/" first so the "/bin/" test matches on Windows
 * (where.exe returns backslash paths), and case-folds on Windows because its
 * filesystem is case-insensitive.
 *
 * Exported (pure) so the wrapper-dir filter can be unit-tested for both
 * platforms without spawning a shell.
 */
export function pickRealBinaryPath(
	candidates: string[],
	homedir: string,
	isWindows: boolean,
): string | null {
	const norm = (value: string): string => {
		const forward = value.replaceAll("\\", "/");
		return isWindows ? forward.toLowerCase() : forward;
	};
	// path.join uses the host separator; build with the caller-declared platform
	// so tests can exercise the Windows filter on a POSIX host.
	const joiner = isWindows ? path.win32 : path.posix;
	const supersetBinDir = norm(joiner.join(homedir, ".ade", "bin"));
	const supersetPrefix = norm(joiner.join(homedir, ".ade-"));
	const filtered = candidates.filter((p) => {
		if (!p) return false;
		const normalized = norm(p);
		if (normalized.startsWith(supersetBinDir)) return false;
		if (normalized.startsWith(supersetPrefix) && normalized.includes("/bin/")) {
			return false;
		}
		return true;
	});
	return filtered[0] || null;
}

/**
 * Finds the real path of a binary, skipping our wrapper scripts.
 */
export function findRealBinary(name: string): string | null {
	try {
		const isWindows = process.platform === "win32";
		const allPaths = isWindows
			? findBinaryPathsWindows(name)
			: findBinaryPathsUnix(name);
		return pickRealBinaryPath(allPaths, os.homedir(), isWindows);
	} catch {
		return null;
	}
}
