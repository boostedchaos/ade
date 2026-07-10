import path from "node:path";

/**
 * Canonicalize a filesystem path so the different-but-equivalent spellings
 * git and our local DB produce for the same worktree compare equal.
 *
 * The problem is Windows-specific: `git worktree list --porcelain` emits
 * forward slashes (`C:/Users/x/repo`) while paths we build with `path.join`
 * use backslashes (`C:\Users\x\repo`), and drive-letter / path casing can
 * drift (`C:\X` vs `c:\x`). With exact string equality every such comparison
 * fails closed, breaking security checks and worktree lookups on Windows.
 *
 * Strategy: resolve to an absolute path (normalizes `.`/`..` and separators to
 * the platform default), then on win32 unify separators to backslash and
 * lowercase so the variants collapse to one form. On POSIX this is a plain
 * `path.posix.resolve` with NO case-folding, so an already-canonical path is
 * returned byte-identical — existing POSIX behavior is preserved.
 *
 * `platform` is injectable so the win32 branch is unit-testable on a POSIX
 * host (uses `path.win32.resolve`, which is host-independent for absolute
 * drive-letter paths).
 */
export function canonicalizePath(
	inputPath: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === "win32") {
		return path.win32.resolve(inputPath).replace(/\//g, "\\").toLowerCase();
	}
	return path.posix.resolve(inputPath);
}
