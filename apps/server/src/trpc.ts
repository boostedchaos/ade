import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";

export interface ServerContext {
	/** Set by the transport layer after bearer-token verification. */
	authed: boolean;
}

const t = initTRPC.context<ServerContext>().create({
	transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Every real procedure goes through this. The only unauthenticated surface is
 * whatever explicitly uses publicProcedure (currently just health.ping).
 */
export const authedProcedure = t.procedure.use(({ ctx, next }) => {
	if (!ctx.authed) {
		throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid token" });
	}
	return next();
});
