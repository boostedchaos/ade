import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import { startHookReceiver } from "@ade/server-core/notifications";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";
import { extractToken, loadOrMintToken, verifyToken } from "./auth";
import type { ServerConfig } from "./config";
import { isLockedOut, recordAuthResult } from "./rate-limit";
import { appRouter } from "./routers";
import { performMailAsk } from "./routers/mail";
import { serveStatic } from "./static";
import type { ServerContext } from "./trpc";

const TRPC_PREFIX = "/trpc";

export interface RunningServer {
	server: Server;
	close(): Promise<void>;
}

export function startServer(config: ServerConfig): Promise<RunningServer> {
	const { token, minted, path } = loadOrMintToken();

	const contextFor = (req: IncomingMessage): ServerContext => {
		if (isLockedOut(req)) return { authed: false };
		const ok = verifyToken(
			token,
			extractToken(req.headers.authorization, req.url),
		);
		recordAuthResult(req, ok);
		return { authed: ok };
	};

	const trpcHandler = createHTTPHandler({
		router: appRouter,
		createContext: ({ req }) => contextFor(req),
	});

	const server = createServer((req, res) => {
		if (req.url?.startsWith(TRPC_PREFIX)) {
			req.url = req.url.slice(TRPC_PREFIX.length) || "/";
			trpcHandler(req, res);
			return;
		}
		// The built webui SPA, same origin (no CORS). 404s fall back to
		// index.html for client-side routing.
		serveStatic(req, res);
	});

	// WebSocket endpoint for subscriptions. The token is verified at upgrade
	// time (Authorization header or ?token= query param) — an unauthenticated
	// socket is refused before tRPC ever sees it.
	const wss = new WebSocketServer({ noServer: true });
	applyWSSHandler({
		wss,
		router: appRouter,
		// Upgrade-time verification is the gate; sockets that reach tRPC are authed.
		createContext: () => ({ authed: true }),
	});

	server.on("upgrade", (req, socket, head) => {
		if (isLockedOut(req)) {
			socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
			socket.destroy();
			return;
		}
		const ok = verifyToken(
			token,
			extractToken(req.headers.authorization, req.url),
		);
		recordAuthResult(req, ok);
		if (!ok || !req.url?.startsWith(TRPC_PREFIX)) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit("connection", ws, req);
		});
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(config.port, config.bind, () => {
			console.log(
				`ade-server listening on http://${config.bind}:${config.port}${TRPC_PREFIX}`,
			);
			if (minted) {
				console.log(`Minted auth token (shown once): ${token}`);
				console.log(`Token stored at: ${path}`);
			} else {
				console.log(`Auth token: ${path}`);
			}

			// Run the agent hook receiver in the server process. Agent CLI hooks
			// curl it at 127.0.0.1:$SUPERSET_PORT/hook/complete (SUPERSET_PORT is
			// injected into every terminal session by buildTerminalEnv and equals
			// DESKTOP_NOTIFICATIONS_PORT), and it re-emits AGENT_LIFECYCLE events
			// that the notifications tRPC subscription streams to web clients.
			// mailAsk: agents POST /mail/ask here (issue #45) — same receiver the
			// lifecycle hooks already reach via SUPERSET_PORT.
			startHookReceiver({ mailAsk: performMailAsk })
				.then((hookReceiver) => {
					resolve({
						server,
						close: () =>
							new Promise<void>((res, rej) => {
								wss.close();
								void hookReceiver.close().finally(() => {
									server.close((e) => (e ? rej(e) : res()));
								});
							}),
					});
				})
				.catch((err) => {
					// A busy hook port must not take down the whole server (e.g. a
					// desktop instance already owns it). Log and run without it.
					console.error(
						"[notifications] hook receiver failed to start; agent attention events will not reach web clients:",
						err,
					);
					resolve({
						server,
						close: () =>
							new Promise<void>((res, rej) => {
								wss.close();
								server.close((e) => (e ? rej(e) : res()));
							}),
					});
				});
		});
	});
}
