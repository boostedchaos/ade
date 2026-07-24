import { collectResourceMetrics } from "@ade/server-core/resource-metrics";
import { authedProcedure, router } from "../trpc";

/**
 * Resource-metrics router — server mirror of the desktop `resourceMetrics`
 * path the TopBar ResourceConsumption panel polls. Thin shell over the
 * extracted server-core collector (per-agent terminal process trees via
 * pidusage; the "app" figure is the server's own process tree).
 */
export const resourceMetricsRouter = router({
	getSnapshot: authedProcedure.query(() => collectResourceMetrics()),
});
