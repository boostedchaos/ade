import { listGitHubRepos } from "@ade/server-core/github-repos";
import { authedProcedure, router } from "../trpc";

/**
 * GitHub repo picker (issue #48) — headless-server mirror of the desktop
 * `github.listRepos` procedure. Thin shell over the shared server-core `gh`
 * CLI wrapper; see apps/desktop/src/lib/trpc/routers/github.ts.
 */
export const githubRouter = router({
	listRepos: authedProcedure.query(() => listGitHubRepos()),
});
