import { observable } from "@trpc/server/observable";
import { authedProcedure, publicProcedure, router } from "../trpc";

const startedAt = Date.now();

// Subscriptions use observables (not async generators) to match the
// trpc-electron semantics the desktop routers were written against — the
// extracted core routers keep working unchanged over WebSocket.
export const healthRouter = router({
	/** Unauthenticated liveness probe. Returns no information. */
	ping: publicProcedure.query(() => "pong" as const),

	info: authedProcedure.query(() => ({
		name: "ade-server",
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		pid: process.pid,
		uptimeMs: Date.now() - startedAt,
	})),

	/** WS smoke-test subscription: emits an incrementing tick every second. */
	tick: authedProcedure.subscription(() =>
		observable<{ n: number; at: number }>((emit) => {
			let n = 0;
			const iv = setInterval(() => emit.next({ n: n++, at: Date.now() }), 1000);
			return () => clearInterval(iv);
		}),
	),
});
