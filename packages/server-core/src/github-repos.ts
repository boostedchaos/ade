import { z } from "zod";
import { execWithShellEnv } from "./shell-env";

/**
 * GitHub repo picker (issue #48) — lets the New Agent modal's "Pick from
 * GitHub" repo mode list the user's repos instead of requiring a
 * hand-pasted clone URL. Rides entirely on the host `gh` CLI's existing
 * auth (same pattern as the PR-status fetcher in
 * apps/desktop/src/lib/trpc/routers/workspaces/utils/github/github.ts) —
 * no OAuth flow, no PAT storage.
 */

const GHRepoListItemSchema = z.object({
	nameWithOwner: z.string(),
	url: z.string(),
	description: z.string().nullable(),
	updatedAt: z.string(),
});

export type GitHubRepoListItem = z.infer<typeof GHRepoListItemSchema>;

export interface ListGitHubReposResult {
	repos: GitHubRepoListItem[];
	authenticated: boolean;
}

const REPO_LIST_LIMIT = 200;

/**
 * Lists the authenticated user's GitHub repos via `gh repo list`. Never
 * throws — `gh` missing, not authenticated, or any other failure (network,
 * malformed output) all degrade to `{ repos: [], authenticated: false }` so
 * callers can render a "run `gh auth login`" hint instead of erroring.
 */
export async function listGitHubRepos(): Promise<ListGitHubReposResult> {
	try {
		const { stdout } = await execWithShellEnv("gh", [
			"repo",
			"list",
			"--json",
			"nameWithOwner,url,description,updatedAt",
			"--limit",
			String(REPO_LIST_LIMIT),
		]);

		const raw: unknown = JSON.parse(stdout);
		if (!Array.isArray(raw)) {
			return { repos: [], authenticated: false };
		}

		const repos: GitHubRepoListItem[] = [];
		for (const item of raw) {
			const result = GHRepoListItemSchema.safeParse(item);
			if (result.success) {
				repos.push(result.data);
			}
		}

		return { repos, authenticated: true };
	} catch {
		// gh not installed, not authenticated, or any other error — treat all
		// the same: an empty, unauthenticated result rather than throwing.
		return { repos: [], authenticated: false };
	}
}
