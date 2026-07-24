import { collectProviderUsage } from "@ade/server-core/provider-usage";
import { authedProcedure, router } from "../trpc";

/**
 * Provider-usage router (issue #35) — feeds the TopBar resource monitor's
 * usage section. Thin shell over the server-core collector (Claude OAuth
 * rate-limit windows + OpenRouter credits, cached 60s).
 */
export const usageRouter = router({
	getSnapshot: authedProcedure.query(() => collectProviderUsage()),
});
