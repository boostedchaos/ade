import { isAbsolute, normalize, resolve, sep } from "node:path";
import { projects, worktrees } from "@superset/local-db";
import { eq } from "drizzle-orm";
import { localDb } from "main/lib/local-db";
import { canonicalizePath } from "./path-canonical";

/**
 * Security model for desktop app filesystem access:
 *
 * THREAT MODEL:
 * While a compromised renderer can execute commands via terminal panes,
 * the File Viewer presents a distinct threat: malicious repositories can
 * contain symlinks that trick users into reading/writing sensitive files
 * (e.g., `docs/config.yml` → `~/.bashrc`). Users clicking these links
 * don't know they're accessing files outside the repo.
 *
 * PRIMARY BOUNDARY: assertRegisteredWorktree()
 * - Only worktree paths registered in localDb are accessible via tRPC
 * - Prevents direct filesystem access to unregistered paths
 *
 * SECONDARY: validateRelativePath()
 * - Rejects absolute paths and ".." traversal segments
 * - Defense in depth against path manipulation
 *
 * SYMLINK PROTECTION (secure-fs.ts):
 * - Writes: Block if realpath escapes worktree (prevents accidental overwrites)
 * - Reads: Caller can check isSymlinkEscaping() to warn users
 */

/**
 * Security error codes for path validation failures.
 */
export type PathValidationErrorCode =
	| "ABSOLUTE_PATH"
	| "PATH_TRAVERSAL"
	| "UNREGISTERED_WORKTREE"
	| "INVALID_TARGET"
	| "SYMLINK_ESCAPE";

/**
 * Error thrown when path validation fails.
 * Includes a code for programmatic handling.
 */
export class PathValidationError extends Error {
	constructor(
		message: string,
		public readonly code: PathValidationErrorCode,
	) {
		super(message);
		this.name = "PathValidationError";
	}
}

/**
 * Validates that a workspace path is registered in localDb.
 * This is THE critical security boundary.
 *
 * Accepts:
 * - Worktree paths (from worktrees table)
 * - Project mainRepoPath (for branch workspaces that work on the main repo)
 *
 * @throws PathValidationError if path is not registered
 */
export function assertRegisteredWorktree(workspacePath: string): void {
	// Exact-match fast path (indexed). On POSIX the stored path is already
	// canonical, so this is the sole path taken and behavior is unchanged.
	const worktreeExists = localDb
		.select()
		.from(worktrees)
		.where(eq(worktrees.path, workspacePath))
		.get();

	if (worktreeExists) {
		return;
	}

	// Check projects.mainRepoPath for branch workspaces
	const projectExists = localDb
		.select()
		.from(projects)
		.where(eq(projects.mainRepoPath, workspacePath))
		.get();

	if (projectExists) {
		return;
	}

	// Canonical fallback: on Windows the incoming path may differ from the
	// stored one only by separator style or drive-letter case. Compare
	// canonical forms on BOTH sides without rewriting what's stored.
	const target = canonicalizePath(workspacePath);
	const worktreeMatch = localDb
		.select()
		.from(worktrees)
		.all()
		.some((w) => canonicalizePath(w.path) === target);
	if (worktreeMatch) {
		return;
	}
	const projectMatch = localDb
		.select()
		.from(projects)
		.all()
		.some((p) => p.mainRepoPath && canonicalizePath(p.mainRepoPath) === target);
	if (projectMatch) {
		return;
	}

	throw new PathValidationError(
		"Workspace path not registered in database",
		"UNREGISTERED_WORKTREE",
	);
}

/**
 * Gets the worktree record if registered. Returns record for updates.
 * Only works for actual worktrees, not project mainRepoPath.
 *
 * @throws PathValidationError if worktree is not registered
 */
export function getRegisteredWorktree(
	worktreePath: string,
): typeof worktrees.$inferSelect {
	const worktree = localDb
		.select()
		.from(worktrees)
		.where(eq(worktrees.path, worktreePath))
		.get();

	if (worktree) {
		return worktree;
	}

	// Canonical fallback for Windows separator/case drift (see
	// assertRegisteredWorktree). POSIX exact-matches above, so this never runs.
	const target = canonicalizePath(worktreePath);
	const match = localDb
		.select()
		.from(worktrees)
		.all()
		.find((w) => canonicalizePath(w.path) === target);

	if (!match) {
		throw new PathValidationError(
			"Worktree not registered in database",
			"UNREGISTERED_WORKTREE",
		);
	}

	return match;
}

/**
 * Options for path validation.
 */
export interface ValidatePathOptions {
	/**
	 * Allow empty/root path (resolves to worktree itself).
	 * Default: false (prevents accidental worktree deletion)
	 */
	allowRoot?: boolean;
}

/**
 * Validates a relative file path for safety.
 * Rejects absolute paths and path traversal attempts.
 *
 * @throws PathValidationError if path is invalid
 */
export function validateRelativePath(
	filePath: string,
	options: ValidatePathOptions = {},
): void {
	const { allowRoot = false } = options;

	// Reject absolute paths
	if (isAbsolute(filePath)) {
		throw new PathValidationError(
			"Absolute paths are not allowed",
			"ABSOLUTE_PATH",
		);
	}

	const normalized = normalize(filePath);
	const segments = normalized.split(sep);

	// Reject ".." as a path segment (allows "..foo" directories)
	if (segments.includes("..")) {
		throw new PathValidationError(
			"Path traversal not allowed",
			"PATH_TRAVERSAL",
		);
	}

	// Reject root path unless explicitly allowed
	if (!allowRoot && (normalized === "" || normalized === ".")) {
		throw new PathValidationError(
			"Cannot target worktree root",
			"INVALID_TARGET",
		);
	}
}

/**
 * Validates and resolves a path within a worktree. Sync, simple.
 *
 * @param worktreePath - The worktree base path
 * @param filePath - The relative file path to validate
 * @param options - Validation options
 * @returns The resolved full path
 * @throws PathValidationError if path is invalid
 */
export function resolvePathInWorktree(
	worktreePath: string,
	filePath: string,
	options: ValidatePathOptions = {},
): string {
	validateRelativePath(filePath, options);
	// Use resolve to handle any worktreePath (relative or absolute)
	return resolve(worktreePath, normalize(filePath));
}

/**
 * Validates a path for git commands. Lighter check that allows root.
 *
 * @throws PathValidationError if path is invalid
 */
export function assertValidGitPath(filePath: string): void {
	validateRelativePath(filePath, { allowRoot: true });
}
