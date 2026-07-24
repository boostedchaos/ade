/**
 * Headless agent-notification plumbing for ade-server.
 *
 * On the desktop, CLI-agent hooks curl an Express server in the Electron main
 * process (`main/lib/notifications/server.ts`), which re-emits lifecycle events
 * to the renderer over a tRPC subscription. This module is the server-side
 * equivalent: a Node `http` receiver that agent hooks POST/GET to, plus the
 * shared `notificationsEmitter` the tRPC `notifications` router subscribes to.
 *
 * ADDRESS INJECTION: agent hooks learn the receiver's address from the
 * `SUPERSET_PORT` env var injected into every terminal session by
 * `buildTerminalEnv` (terminal/env.ts) — it is set to
 * `env.DESKTOP_NOTIFICATIONS_PORT`. The hook script curls
 * `http://127.0.0.1:${SUPERSET_PORT}/hook/complete`. Because the same env
 * module is shared by the desktop and the server, the server only has to run
 * this receiver on `env.DESKTOP_NOTIFICATIONS_PORT` and the injection already
 * lines up — no terminal-env changes required.
 */
import { EventEmitter } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type Server,
} from "node:http";
import {
	type AskAgentResult,
	MailError,
	verifyMailToken,
} from "../agent-mail";
import { NOTIFICATION_EVENTS } from "../constants";
import { env } from "../env.shared";
import { HOOK_PROTOCOL_VERSION } from "../terminal/env";
import { mapEventType } from "./map-event-type";
import type { AgentLifecycleEvent } from "./types";

export { mapEventType } from "./map-event-type";
export type { AgentLifecycleEvent, NotificationIds } from "./types";

/**
 * The single emitter the `notifications` tRPC router subscribes to. Hook
 * requests received by the receiver below re-emit `AGENT_LIFECYCLE` here.
 */
export const notificationsEmitter = new EventEmitter();

const SERVER_ENV =
	env.NODE_ENV === "development" ? "development" : "production";
const debugHooksOverride = process.env.SUPERSET_DEBUG_HOOKS?.trim();
const DEBUG_HOOKS_ENABLED =
	debugHooksOverride === undefined
		? SERVER_ENV === "development"
		: !/^(0|false)$/i.test(debugHooksOverride);

export interface HookReceiver {
	/** The port the receiver bound to. */
	port: number;
	/** Stop the receiver and release the port. */
	close(): Promise<void>;
}

/**
 * Agent-mail ask (issue #45), wired in by the host (apps/server resolves the
 * roster from its DB and calls askAgent). Input is the raw parsed JSON body;
 * the handler validates it.
 */
export type MailAskHandler = (body: {
	from: string;
	to: string;
	question: string;
	depth: number;
}) => Promise<AskAgentResult>;

const MAX_MAIL_BODY_BYTES = 256 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
			if (body.length > MAX_MAIL_BODY_BYTES) {
				reject(new Error("Body too large"));
				req.destroy();
			}
		});
		req.on("end", () => resolve(body));
		req.on("error", reject);
	});
}

/**
 * POST /mail/ask — the endpoint an agent calls from inside its terminal
 * session (address = 127.0.0.1:$SUPERSET_PORT, already injected by
 * buildTerminalEnv). Unlike /hook/complete this spawns work, so it requires
 * the ~/.ade/token bearer (agents can read that file; other local
 * processes shouldn't).
 */
async function handleMailAsk(
	req: IncomingMessage,
	mailAsk: MailAskHandler | undefined,
): Promise<HookResult> {
	if (!mailAsk) {
		return { status: 503, body: { error: "Agent mail is not available" } };
	}
	const auth = req.headers.authorization;
	const bearer = auth?.startsWith("Bearer ")
		? auth.slice("Bearer ".length).trim()
		: undefined;
	if (!verifyMailToken(bearer)) {
		return { status: 401, body: { error: "Unauthorized" } };
	}
	let parsed: Record<string, unknown>;
	try {
		const raw: unknown = JSON.parse(await readBody(req));
		// JSON.parse can yield primitives/null — destructuring those throws.
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { status: 400, body: { error: "Expected a JSON object body" } };
		}
		parsed = raw as Record<string, unknown>;
	} catch {
		return { status: 400, body: { error: "Invalid JSON body" } };
	}
	const { from, to, question } = parsed;
	const depth = parsed.depth ?? 0;
	if (
		typeof from !== "string" ||
		typeof to !== "string" ||
		typeof question !== "string" ||
		typeof depth !== "number" ||
		!Number.isInteger(depth) ||
		depth < 0
	) {
		return {
			status: 400,
			body: {
				error:
					'Expected {"from": "<your agent id>", "to": "<agent name>", "question": "...", "depth": <int >= 0>}',
			},
		};
	}
	try {
		const result = await mailAsk({ from, to, question, depth });
		return { status: 200, body: { ...result } };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// MailError = a refused/failed ask the agent should read; anything else
		// is a server bug and shouldn't leak internals.
		if (error instanceof MailError) {
			return { status: 400, body: { error: message } };
		}
		console.error("[mail] ask failed:", error);
		return { status: 500, body: { error: "Internal error" } };
	}
}

interface HookResult {
	status: number;
	body: Record<string, unknown>;
}

/**
 * Processes a `/hook/complete` request's query params and, when it maps to a
 * real lifecycle event, emits `AGENT_LIFECYCLE`. Returns the JSON response the
 * receiver should send back. Exported for unit testing without a live socket.
 *
 * Unlike the desktop, the server does not resolve `paneId` from a synced tabs
 * state — the terminal env already injects the real `SUPERSET_PANE_ID`, so the
 * hook carries the correct ids and they are passed through as-is.
 */
export function handleHookComplete(query: URLSearchParams): HookResult {
	const clientEnv = query.get("env") ?? undefined;
	const version = query.get("version") ?? undefined;
	const eventType = query.get("eventType") ?? undefined;
	const paneId = query.get("paneId") || undefined;
	const tabId = query.get("tabId") || undefined;
	const workspaceId = query.get("workspaceId") || undefined;
	const sessionId = query.get("sessionId") || undefined;

	// Environment validation: detect dev/prod cross-talk. We still return
	// success so the agent is never blocked, but drop the event.
	if (clientEnv && clientEnv !== SERVER_ENV) {
		console.warn(
			`[notifications] Environment mismatch: received ${clientEnv} request on ${SERVER_ENV} server. ` +
				"This may indicate a stale hook or misconfigured terminal. Ignoring request.",
		);
		return {
			status: 200,
			body: { success: true, ignored: true, reason: "env_mismatch" },
		};
	}

	if (version && version !== HOOK_PROTOCOL_VERSION) {
		console.log(
			`[notifications] Received hook v${version} request (server expects v${HOOK_PROTOCOL_VERSION})`,
		);
	}

	const mappedEventType = mapEventType(eventType);

	// Unknown/missing eventType: succeed but don't process (forward compat).
	if (!mappedEventType) {
		if (eventType) {
			console.log("[notifications] Ignoring unknown eventType:", eventType);
		}
		return { status: 200, body: { success: true, ignored: true } };
	}

	const event: AgentLifecycleEvent = {
		paneId,
		tabId,
		workspaceId,
		eventType: mappedEventType,
	};

	if (DEBUG_HOOKS_ENABLED) {
		console.log("[notifications] hook event received", {
			eventType,
			mappedEventType,
			paneId,
			tabId,
			workspaceId,
			sessionId,
		});
	}

	notificationsEmitter.emit(NOTIFICATION_EVENTS.AGENT_LIFECYCLE, event);

	return { status: 200, body: { success: true, paneId, tabId } };
}

/**
 * Starts the hook receiver on 127.0.0.1:`port` (defaults to
 * `env.DESKTOP_NOTIFICATIONS_PORT`, the same value injected as `SUPERSET_PORT`).
 * Loopback-only: agent hooks always curl 127.0.0.1.
 */
export function startHookReceiver(opts?: {
	port?: number;
	host?: string;
	mailAsk?: MailAskHandler;
}): Promise<HookReceiver> {
	const port = opts?.port ?? env.DESKTOP_NOTIFICATIONS_PORT;
	const host = opts?.host ?? "127.0.0.1";

	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");

		if (req.method === "OPTIONS") {
			res.writeHead(200, corsHeaders()).end();
			return;
		}

		if (url.pathname === "/hook/complete") {
			const { status, body } = handleHookComplete(url.searchParams);
			sendJson(res, status, body);
			return;
		}

		if (url.pathname === "/mail/ask" && req.method === "POST") {
			void handleMailAsk(req, opts?.mailAsk)
				.then(({ status, body }) => sendJson(res, status, body))
				.catch((err) => {
					// Last-resort guard: an escaped throw must not become an
					// unhandled rejection (process-fatal) + a hung socket.
					console.error("[mail] ask handler crashed:", err);
					sendJson(res, 500, { error: "Internal error" });
				});
			return;
		}

		if (url.pathname === "/health") {
			sendJson(res, 200, { status: "ok" });
			return;
		}

		sendJson(res, 404, { error: "Not found" });
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			console.log(
				`[notifications] hook receiver listening on http://${host}:${port}/hook/complete`,
			);
			resolve({
				port,
				close: () =>
					new Promise<void>((res, rej) => {
						server.close((e) => (e ? rej(e) : res()));
					}),
			});
		});
	});
}

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	};
}

function sendJson(
	res: import("node:http").ServerResponse,
	status: number,
	body: Record<string, unknown>,
): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		...corsHeaders(),
	});
	res.end(payload);
}
