import { execFile } from "node:child_process";
import { promisify } from "node:util";
import simpleGit from "simple-git";

const execFileAsync = promisify(execFile);

/**
 * Git identity/branch helpers — server ports of the desktop's
 * workspaces/utils/git.ts and shared/utils/branch.ts pieces the settings
 * surfaces need. Kept behavior-identical so desktop and web report the same
 * values against the same repos.
 */

export function sanitizeAuthorPrefix(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9._+@-]/g, "")
		.replace(/\.{2,}/g, ".")
		.replace(/@\{/g, "@")
		.replace(/-+/g, "-")
		.replace(/^[-.]|[-.]+$/g, "")
		.replace(/\.lock$/g, "")
		.slice(0, 50);
}

export async function getGitAuthorName(
	repoPath?: string,
): Promise<string | null> {
	try {
		const git = repoPath ? simpleGit(repoPath) : simpleGit();
		const name = await git.getConfig("user.name");
		return name.value?.trim() || null;
	} catch (error) {
		console.warn("[git/getGitAuthorName] Failed to read git user.name:", error);
		return null;
	}
}

let cachedGitHubUsername: { value: string | null; timestamp: number } | null =
	null;
const GITHUB_USERNAME_CACHE_TTL = 5 * 60 * 1000;

export async function getGitHubUsername(): Promise<string | null> {
	if (
		cachedGitHubUsername &&
		Date.now() - cachedGitHubUsername.timestamp < GITHUB_USERNAME_CACHE_TTL
	) {
		return cachedGitHubUsername.value;
	}

	try {
		const { stdout } = await execFileAsync(
			"gh",
			["api", "user", "--jq", ".login"],
			{ timeout: 10_000 },
		);
		const value = stdout.trim() || null;
		cachedGitHubUsername = { value, timestamp: Date.now() };
		return value;
	} catch (error) {
		console.warn(
			"[git/getGitHubUsername] Failed to get GitHub username:",
			error instanceof Error ? error.message : String(error),
		);
		cachedGitHubUsername = { value: null, timestamp: Date.now() };
		return null;
	}
}

export async function hasOriginRemote(repoPath: string): Promise<boolean> {
	try {
		const remotes = await simpleGit(repoPath).getRemotes();
		return remotes.some((r) => r.name === "origin");
	} catch {
		return false;
	}
}

export async function getDefaultBranch(mainRepoPath: string): Promise<string> {
	const git = simpleGit(mainRepoPath);
	const hasRemote = await hasOriginRemote(mainRepoPath);

	if (hasRemote) {
		try {
			const headRef = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
			const match = headRef.trim().match(/refs\/remotes\/origin\/(.+)/);
			if (match) return match[1];
		} catch {}

		try {
			const branches = await git.branch(["-r"]);
			const remoteBranches = branches.all.map((b) => b.replace("origin/", ""));
			for (const candidate of ["main", "master", "develop", "trunk"]) {
				if (remoteBranches.includes(candidate)) {
					return candidate;
				}
			}
		} catch {}

		try {
			const result = await git.raw(["ls-remote", "--symref", "origin", "HEAD"]);
			const symrefMatch = result.match(/ref:\s+refs\/heads\/(.+?)\tHEAD/);
			if (symrefMatch) {
				return symrefMatch[1];
			}
		} catch {}
	} else {
		try {
			const current = (
				await git.raw(["rev-parse", "--abbrev-ref", "HEAD"])
			).trim();
			if (current && current !== "HEAD") {
				return current;
			}
		} catch {}

		try {
			const localBranches = await git.branchLocal();
			for (const candidate of ["main", "master", "develop", "trunk"]) {
				if (localBranches.all.includes(candidate)) {
					return candidate;
				}
			}
			if (localBranches.all.length > 0) {
				return localBranches.all[0];
			}
		} catch {}
	}

	return "main";
}

/**
 * Refreshes the local origin/HEAD symref from the remote and returns the
 * current default branch, detecting a remote default-branch change
 * (e.g. master -> main). Returns null when there is no remote or no network.
 */
export async function refreshDefaultBranch(
	mainRepoPath: string,
): Promise<string | null> {
	const git = simpleGit(mainRepoPath);

	if (!(await hasOriginRemote(mainRepoPath))) {
		return null;
	}

	try {
		// Git doesn't auto-update origin/HEAD on fetch, so we must explicitly
		// sync it to detect when the remote's default branch changes
		await git.remote(["set-head", "origin", "--auto"]);

		const headRef = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
		const match = headRef.trim().match(/refs\/remotes\/origin\/(.+)/);
		if (match) {
			return match[1];
		}
	} catch {
		// set-head requires network access; fall back to ls-remote
		try {
			const result = await git.raw(["ls-remote", "--symref", "origin", "HEAD"]);
			const symrefMatch = result.match(/ref:\s+refs\/heads\/(.+?)\tHEAD/);
			if (symrefMatch) {
				return symrefMatch[1];
			}
		} catch {
			// Network unavailable - caller will use cached value
		}
	}

	return null;
}
