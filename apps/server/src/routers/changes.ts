import {
	getBranches,
	getCommitFiles,
	getFileContents,
	getStatus,
	NotGitRepoError,
	readWorkingFile,
	readWorkingFileImage,
} from "@ade/server-core/changes";
import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { authedProcedure, router } from "../trpc";

/**
 * Changes router — server mirror of the desktop `changes` paths the file
 * viewers call (PHASE_2: the desktop router tree is the API contract). Thin
 * shell over the extracted server-core `changes` logic, which preserves the
 * registered-worktree security boundary and symlink-escape checks. Only the
 * read + diff surface the browser viewers use is mirrored; git-mutation
 * procedures (staging/commit/push) remain desktop-only for now.
 */
export const changesRouter = router({
	readWorkingFile: authedProcedure
		.input(z.object({ worktreePath: z.string(), filePath: z.string() }))
		.query(({ input }) => readWorkingFile(input.worktreePath, input.filePath)),

	readWorkingFileImage: authedProcedure
		.input(z.object({ worktreePath: z.string(), filePath: z.string() }))
		.query(({ input }) =>
			readWorkingFileImage(input.worktreePath, input.filePath),
		),

	getFileContents: authedProcedure
		.input(
			z.object({
				worktreePath: z.string(),
				filePath: z.string(),
				oldPath: z.string().optional(),
				category: z.enum(["against-base", "committed", "staged", "unstaged"]),
				commitHash: z.string().optional(),
				defaultBranch: z.string().optional(),
			}),
		)
		.query(({ input }) => getFileContents(input)),

	getBranches: authedProcedure
		.input(z.object({ worktreePath: z.string() }))
		.query(({ input }) => getBranches(input.worktreePath)),

	getStatus: authedProcedure
		.input(
			z.object({
				worktreePath: z.string(),
				defaultBranch: z.string().optional(),
			}),
		)
		.query(async ({ input }) => {
			try {
				return await getStatus(input.worktreePath, input.defaultBranch);
			} catch (error) {
				if (error instanceof NotGitRepoError) {
					throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
				}
				throw error;
			}
		}),

	getCommitFiles: authedProcedure
		.input(z.object({ worktreePath: z.string(), commitHash: z.string() }))
		.query(({ input }) => getCommitFiles(input.worktreePath, input.commitHash)),
});
