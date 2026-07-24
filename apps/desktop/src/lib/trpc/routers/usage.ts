import { collectProviderUsage } from "@ade/server-core/provider-usage";
// Side-effect import: registers the Electron safeStorage SecretStore the
// collector's OpenRouter key lookup depends on.
import "main/lib/provider-keys";
import { publicProcedure, router } from "..";

export const createUsageRouter = () => {
	return router({
		getSnapshot: publicProcedure.query(() => collectProviderUsage()),
	});
};
