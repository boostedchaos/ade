import {
	createTRPCProxyClient,
	createWSClient,
	httpBatchLink,
	splitLink,
	wsLink,
} from "@trpc/client";
import type { AppRouter } from "lib/trpc/routers";
import superjson from "superjson";
import { electronTrpc } from "../../desktop/src/renderer/lib/electron-trpc";
import { sessionIdLink } from "../../desktop/src/renderer/lib/session-id-link";
import { getAuthToken } from "./auth-token";

/**
 * Web transport for the renderer (PHASE_2.md §2): drop-in replacement for
 * the desktop's lib/trpc-client (aliased in vite.config.ts). Same exported
 * names, HTTP batch + WS links instead of Electron IPC — the designed-in
 * seam from PLAN_MAIN D4.
 */

const wsProto = location.protocol === "https:" ? "wss" : "ws";

const wsClient = createWSClient({
	url: () => `${wsProto}://${location.host}/trpc?token=${getAuthToken() ?? ""}`,
	retryDelayMs: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
});

function links() {
	return [
		sessionIdLink<AppRouter>(),
		splitLink({
			// Subscriptions must ride the WS; terminal mutations (write/resize —
			// every keystroke) do too, so typing costs one WS frame instead of an
			// HTTP POST (issue #59). Auth is carried by the WS URL (?token=) and
			// verified at upgrade time; wsLink buffers ops across reconnects, so
			// mutations are as safe here as the existing stream subscription.
			// Queries stay on httpBatchLink for react-query batching.
			condition: (op) =>
				op.type === "subscription" ||
				(op.type === "mutation" && op.path.startsWith("terminal.")),
			true: wsLink<AppRouter>({ client: wsClient, transformer: superjson }),
			false: httpBatchLink({
				url: "/trpc",
				transformer: superjson,
				headers: () => {
					const token = getAuthToken();
					return token ? { authorization: `Bearer ${token}` } : {};
				},
			}),
		}),
	];
}

/** React-hooks client (same name the desktop renderer imports). */
export const electronReactClient = electronTrpc.createClient({
	links: links(),
});

/** Imperative proxy client for stores/utilities (same name as desktop). */
export const electronTrpcClient = createTRPCProxyClient<AppRouter>({
	links: links(),
});
