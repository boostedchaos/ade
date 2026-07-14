import { TRPCError } from "@trpc/server";
import simpleGit from "simple-git";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	execWithShellEnv,
	getProcessEnvWithShellPath,
} from "../workspaces/utils/shell-env";
import { isUpstreamMissingError } from "./git-utils";
import { assertRegisteredWorktree } from "./security";

export { isUpstreamMissingError };

async function hasUpstreamBranch(
	git: ReturnType<typeof simpleGit>,
): Promise<boolean> {
	try {
		await git.raw(["rev-parse", "--abbrev-ref", "@{upstream}"]);
		return true;
	} catch {
		return false;
	}
}

async function fetchCurrentBranch(
	git: ReturnType<typeof simpleGit>,
): Promise<void> {
	const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
	try {
		await git.fetch(["origin", branch]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isUpstreamMissingError(message)) {
			try {
				await git.fetch(["origin"]);
			} catch (fallbackError) {
				const fallbackMessage =
					fallbackError instanceof Error
						? fallbackError.message
						: String(fallbackError);
				if (!isUpstreamMissingError(fallbackMessage)) {
					console.error(
						`[git/fetch] failed fallback fetch for branch ${branch}:`,
						fallbackError,
					);
					throw fallbackError;
				}
			}
			return;
		}
		throw error;
	}
}

async function pushWithSetUpstream({
	git,
	branch,
}: {
	git: ReturnType<typeof simpleGit>;
	branch: string;
}): Promise<void> {
	const trimmedBranch = branch.trim();
	if (!trimmedBranch || trimmedBranch === "HEAD") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Cannot push from detached HEAD. Please checkout a branch and try again.",
		});
	}

	// Use HEAD refspec to avoid resolving the branch name as a local ref.
	// This is more reliable for worktrees where upstream tracking isn't set yet.
	await git.push([
		"--set-upstream",
		"origin",
		`HEAD:refs/heads/${trimmedBranch}`,
	]);
}

function shouldRetryPushWithUpstream(message: string): boolean {
	const lowerMessage = message.toLowerCase();
	return (
		lowerMessage.includes("no upstream branch") ||
		lowerMessage.includes("no tracking information") ||
		lowerMessage.includes(
			"upstream branch of your current branch does not match",
		) ||
		lowerMessage.includes("cannot be resolved to branch") ||
		lowerMessage.includes("couldn't find remote ref")
	);
}

async function getGitWithShellPath(worktreePath: string) {
	const git = simpleGit(worktreePath);
	git.env(await getProcessEnvWithShellPath());
	return git;
}

async function resolveDefaultBranch(
	git: ReturnType<typeof simpleGit>,
): Promise<string> {
	try {
		const headRef = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
		const match = headRef.match(/refs\/remotes\/origin\/(.+)/);
		if (match) {
			return match[1].trim();
		}
	} catch {}
	// Fallback when origin/HEAD isn't set: prefer main, then master.
	try {
		const branches = await git.branch(["-r"]);
		if (branches.all.includes("origin/main")) return "main";
		if (branches.all.includes("origin/master")) return "master";
	} catch {}
	return "main";
}

export const createGitOperationsRouter = () => {
	return router({
		// NOTE: saveFile is defined in file-contents.ts with hardened path validation
		// Do NOT add saveFile here - it would overwrite the secure version

		commit: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					message: z.string(),
				}),
			)
			.mutation(
				async ({ input }): Promise<{ success: boolean; hash: string }> => {
					assertRegisteredWorktree(input.worktreePath);

					const git = await getGitWithShellPath(input.worktreePath);
					const result = await git.commit(input.message);
					return { success: true, hash: result.commit };
				},
			),

		push: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					setUpstream: z.boolean().optional(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				const git = await getGitWithShellPath(input.worktreePath);
				const hasUpstream = await hasUpstreamBranch(git);

				if (input.setUpstream && !hasUpstream) {
					const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
					await pushWithSetUpstream({ git, branch });
				} else {
					try {
						await git.push();
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						if (shouldRetryPushWithUpstream(message)) {
							const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
							await pushWithSetUpstream({ git, branch });
						} else {
							throw error;
						}
					}
				}
				await fetchCurrentBranch(git);
				return { success: true };
			}),

		pull: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				const git = await getGitWithShellPath(input.worktreePath);
				try {
					await git.pull(["--rebase"]);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (isUpstreamMissingError(message)) {
						throw new Error(
							"No upstream branch to pull from. The remote branch may have been deleted.",
						);
					}
					throw error;
				}
				return { success: true };
			}),

		sync: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);

				const git = await getGitWithShellPath(input.worktreePath);
				try {
					await git.pull(["--rebase"]);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					if (isUpstreamMissingError(message)) {
						const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
						await pushWithSetUpstream({ git, branch });
						await fetchCurrentBranch(git);
						return { success: true };
					}
					throw error;
				}
				await git.push();
				await fetchCurrentBranch(git);
				return { success: true };
			}),

		fetch: publicProcedure
			.input(z.object({ worktreePath: z.string() }))
			.mutation(async ({ input }): Promise<{ success: boolean }> => {
				assertRegisteredWorktree(input.worktreePath);
				const git = await getGitWithShellPath(input.worktreePath);
				await fetchCurrentBranch(git);
				return { success: true };
			}),

		createPR: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
				}),
			)
			.mutation(
				async ({ input }): Promise<{ success: boolean; url: string }> => {
					assertRegisteredWorktree(input.worktreePath);

					const git = await getGitWithShellPath(input.worktreePath);
					const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
					const hasUpstream = await hasUpstreamBranch(git);

					// Ensure branch is pushed first
					if (!hasUpstream) {
						await pushWithSetUpstream({ git, branch });
					} else {
						// Push any unpushed commits
						try {
							await git.push();
						} catch (error) {
							const message =
								error instanceof Error ? error.message : String(error);
							if (shouldRetryPushWithUpstream(message)) {
								await pushWithSetUpstream({ git, branch });
							} else {
								throw error;
							}
						}
					}

					const { stdout } = await execWithShellEnv(
						"gh",
						["pr", "create", "--web", "--fill", "--head", branch],
						{ cwd: input.worktreePath },
					);

					const url = stdout.trim() || "https://github.com";
					await fetchCurrentBranch(git);

					return { success: true, url };
				},
			),

		mergePR: publicProcedure
			.input(
				z.object({
					worktreePath: z.string(),
					strategy: z.enum(["merge", "squash", "rebase"]).default("squash"),
				}),
			)
			.mutation(
				async ({ input }): Promise<{ success: boolean; mergedAt?: string }> => {
					assertRegisteredWorktree(input.worktreePath);

					const args = ["pr", "merge", `--${input.strategy}`];

					try {
						await execWithShellEnv("gh", args, { cwd: input.worktreePath });
						return { success: true, mergedAt: new Date().toISOString() };
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						console.error("[git/mergePR] Failed to merge PR:", message);

						if (message.includes("no pull requests found")) {
							throw new TRPCError({
								code: "NOT_FOUND",
								message: "No pull request found for this branch",
							});
						}
						if (
							message.includes("not mergeable") ||
							message.includes("blocked")
						) {
							throw new TRPCError({
								code: "BAD_REQUEST",
								message:
									"PR cannot be merged. Check for merge conflicts or required status checks.",
							});
						}
						throw new TRPCError({
							code: "INTERNAL_SERVER_ERROR",
							message: `Failed to merge PR: ${message}`,
						});
					}
				},
			),

		rebaseOntoDefault: publicProcedure
			.input(z.object({ worktreePath: z.string() }))
			.mutation(
				async ({
					input,
				}): Promise<
					| { success: true; rebasedOnto: string }
					| {
							success: false;
							conflictedFiles: string[];
							defaultBranch: string;
					  }
				> => {
					assertRegisteredWorktree(input.worktreePath);

					const git = await getGitWithShellPath(input.worktreePath);
					const defaultBranch = await resolveDefaultBranch(git);

					// Pull the latest default branch so we rebase onto current tip.
					await git.fetch(["origin", defaultBranch]);

					try {
						// --autostash keeps a dirty worktree safe (stashed before,
						// restored after) so the caller needn't pre-commit.
						await git.rebase(["--autostash", `origin/${defaultBranch}`]);
						return { success: true, rebasedOnto: defaultBranch };
					} catch (error) {
						// Conflict (or other failure): capture the conflicted paths,
						// then abort to restore a clean checkout. Aborting also pops
						// the autostash, so the worktree returns to its prior state.
						let conflictedFiles: string[] = [];
						try {
							const diff = await git.raw([
								"diff",
								"--name-only",
								"--diff-filter=U",
							]);
							conflictedFiles = diff
								.split("\n")
								.map((f) => f.trim())
								.filter(Boolean);
						} catch {}

						try {
							await git.rebase(["--abort"]);
						} catch (abortError) {
							console.error(
								"[git/rebaseOntoDefault] Failed to abort rebase:",
								abortError,
							);
						}

						if (conflictedFiles.length === 0) {
							// No parseable conflict — surface the underlying failure.
							const message =
								error instanceof Error ? error.message : String(error);
							throw new TRPCError({
								code: "INTERNAL_SERVER_ERROR",
								message: `Failed to rebase onto ${defaultBranch}: ${message}`,
							});
						}

						// Expected outcome: report conflicts as data, not an error, so
						// the renderer can show the file list instead of a raw string.
						return { success: false, conflictedFiles, defaultBranch };
					}
				},
			),

		ghAvailable: publicProcedure.query(
			async (): Promise<{ available: boolean }> => {
				try {
					await execWithShellEnv("gh", ["--version"]);
					return { available: true };
				} catch {
					return { available: false };
				}
			},
		),
	});
};
