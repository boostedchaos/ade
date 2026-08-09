import { createServer, type Server, type Socket } from "node:net";
import { ControlEventBus } from "./event-bus";
import type { ControlPlaneHost } from "./host";
import { encodeNdjson, NdjsonParser } from "./ndjson";
import {
	CONTROL_PROTOCOL_VERSION,
	ControlError,
	type ControlEvent,
	type ControlEventKind,
	type ControlRequest,
	errorResponse,
	isControlEventKind,
	previewLine,
	successResponse,
} from "./protocol";
import {
	chmodSocketFile,
	isNamedPipePath,
	removeSocketFile,
} from "./socket-path";
import { tokensMatch, writeControlToken } from "./token";

/**
 * Proof-of-authentication. A handler can only be called with one of these, and
 * the only place one is constructed is inside the hello gate below. That is
 * what "no handler is reachable unauthenticated by construction" means here —
 * it is a type-level guarantee, not a check each handler remembers to make.
 * The terminal-host daemon copy-pastes its check into eleven handlers; one
 * omission there silently opens a command.
 */
export class AuthenticatedSession {
	private readonly brand = Symbol("authenticated");

	private constructor(
		readonly client: string,
		readonly host: ControlPlaneHost,
		readonly events: ControlEventBus,
	) {
		void this.brand;
	}

	/** @internal — only server.ts may mint one. */
	static _mint(
		client: string,
		host: ControlPlaneHost,
		events: ControlEventBus,
	): AuthenticatedSession {
		return new AuthenticatedSession(client, host, events);
	}
}

export type CommandHandler = (
	session: AuthenticatedSession,
	args: Record<string, unknown>,
) => Promise<unknown> | unknown;

export type CommandRegistry = Record<string, CommandHandler>;

export interface ControlPlaneServerOptions {
	socketPath: string;
	tokenPath: string;
	host: ControlPlaneHost;
	commands: CommandRegistry;
	events?: ControlEventBus;
}

interface ConnectionState {
	session: AuthenticatedSession | null;
	/** Set once `subscribe` upgrades the connection; it then takes no requests. */
	unsubscribe: (() => void) | null;
	parser: NdjsonParser<unknown>;
}

export class ControlPlaneServer {
	readonly events: ControlEventBus;
	private server: Server | null = null;
	private token: string | null = null;
	private readonly connections = new Map<Socket, ConnectionState>();

	constructor(private readonly options: ControlPlaneServerOptions) {
		this.events = options.events ?? new ControlEventBus();
	}

	/** The per-launch token. Null before start(). Never log this. */
	get currentToken(): string | null {
		return this.token;
	}

	async start(): Promise<void> {
		if (this.server) return;

		const { socketPath, tokenPath } = this.options;

		// Unconditional write: the control token rotates every launch.
		this.token = writeControlToken(tokenPath);

		// A leftover socket file from a crash would make listen() fail with
		// EADDRINUSE even though nothing is listening.
		removeSocketFile(socketPath);

		const server = createServer((socket) => this.handleConnection(socket));
		this.server = server;

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error): void => {
				server.off("listening", onListening);
				this.server = null;
				reject(err);
			};
			const onListening = (): void => {
				server.off("error", onError);
				chmodSocketFile(socketPath, 0o600);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			// Pipe intentionally left at the default DACL (Everyone = read-only,
			// cannot write commands). NEVER pass readableAll/writableAll — they
			// widen to Everyone-write and libuv has no API to narrow it back.
			server.listen(socketPath);
		});

		// Post-listen errors must not take the app down.
		server.on("error", (err) => {
			this.options.host.log("error", `control socket error: ${err.message}`);
		});

		this.options.host.log(
			"info",
			`control socket listening on ${socketPath}${
				isNamedPipePath(socketPath) ? " (named pipe)" : ""
			}`,
		);
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		for (const socket of [...this.connections.keys()]) {
			this.closeConnection(socket);
		}
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
		removeSocketFile(this.options.socketPath);
	}

	private handleConnection(socket: Socket): void {
		socket.setEncoding("utf8");
		const state: ConnectionState = {
			session: null,
			unsubscribe: null,
			parser: new NdjsonParser(),
		};
		this.connections.set(socket, state);

		socket.on("data", (chunk: string) => {
			const { values, invalid } = state.parser.parse(chunk);

			if (state.parser.overflowed) {
				this.options.host.log(
					"warn",
					"control socket: line exceeded 1 MiB without a newline; closing",
				);
				this.closeConnection(socket);
				return;
			}

			for (const line of invalid) {
				this.options.host.log(
					"warn",
					`control socket: unparseable line: ${previewLine(line)}`,
				);
			}
			if (invalid.length > 0 && !state.session) {
				// A malformed FIRST line is an unauthenticated peer sending
				// garbage; do not leave the connection open for a retry.
				this.write(socket, errorResponse("", "BAD_REQUEST", "Malformed JSON"));
				this.closeConnection(socket);
				return;
			}

			for (const value of values) {
				void this.handleMessage(socket, state, value);
			}
		});

		socket.on("error", () => this.closeConnection(socket));
		socket.on("close", () => this.closeConnection(socket));
	}

	private async handleMessage(
		socket: Socket,
		state: ConnectionState,
		raw: unknown,
	): Promise<void> {
		if (!this.connections.has(socket)) return;

		const request = raw as Partial<ControlRequest> | null;
		if (!request || typeof request !== "object") {
			this.write(
				socket,
				errorResponse("", "BAD_REQUEST", "Expected a JSON object"),
			);
			return;
		}
		const id = typeof request.id === "string" ? request.id : "";
		const cmd = typeof request.cmd === "string" ? request.cmd : "";

		// ---- the auth gate. Everything below it needs a session object that
		// only this branch can produce.
		if (!state.session) {
			if (cmd !== "hello") {
				this.write(
					socket,
					errorResponse(id, "AUTH_REQUIRED", "First message must be hello"),
				);
				this.closeConnection(socket);
				return;
			}
			if (!this.token || !tokensMatch(this.token, request.token)) {
				this.write(
					socket,
					errorResponse(id, "AUTH_FAILED", "Invalid or missing token"),
				);
				this.closeConnection(socket);
				return;
			}
			state.session = AuthenticatedSession._mint(
				typeof request.client === "string" ? request.client : "unknown",
				this.options.host,
				this.events,
			);
			this.write(
				socket,
				successResponse(id, {
					protocol: CONTROL_PROTOCOL_VERSION,
					app: this.options.host.appVersion,
				}),
			);
			return;
		}

		if (cmd === "hello") {
			this.write(
				socket,
				errorResponse(id, "BAD_REQUEST", "Already authenticated"),
			);
			return;
		}

		if (state.unsubscribe) {
			this.write(
				socket,
				errorResponse(
					id,
					"BAD_REQUEST",
					"Connection is in event-stream mode and accepts no further requests",
				),
			);
			return;
		}

		if (cmd === "subscribe") {
			this.startStream(socket, state, id, request.args ?? {});
			return;
		}

		const handler = this.options.commands[cmd];
		if (!handler) {
			this.write(
				socket,
				errorResponse(id, "BAD_REQUEST", `Unknown command "${cmd}"`),
			);
			return;
		}

		try {
			const result = await handler(state.session, request.args ?? {});
			this.write(socket, successResponse(id, result ?? null));
		} catch (error) {
			if (error instanceof ControlError) {
				this.write(socket, errorResponse(id, error.code, error.message));
				return;
			}
			const message =
				error instanceof Error ? error.message : "Unknown internal error";
			this.options.host.log("error", `command "${cmd}" failed: ${message}`);
			this.write(socket, errorResponse(id, "INTERNAL", message));
		}
	}

	private startStream(
		socket: Socket,
		state: ConnectionState,
		id: string,
		args: Record<string, unknown>,
	): void {
		const rawKinds = args.kinds;
		let kinds: ControlEventKind[] | "all";

		if (rawKinds === undefined || rawKinds === "*") {
			kinds = "all";
		} else if (Array.isArray(rawKinds)) {
			if (rawKinds.includes("*")) {
				kinds = "all";
			} else {
				const known = rawKinds.filter(isControlEventKind);
				// Unknown kinds are ignored rather than rejected, so a newer CLI
				// asking for a kind this app does not emit yet still connects.
				kinds = known;
			}
		} else {
			this.write(
				socket,
				errorResponse(id, "BAD_REQUEST", "subscribe.kinds must be an array"),
			);
			return;
		}

		this.write(socket, successResponse(id, { subscribed: true }));

		// Writing the ack can fail, and `write` responds to that by closing the
		// connection — which unsubscribes a handle that is still null and drops
		// `state` from `connections`. Subscribing anyway would attach a listener
		// to a state object nothing can ever reach again, leaking one closure
		// into the bus per occurrence. Re-check rather than subscribing before
		// the ack, so an event can never be framed ahead of it.
		if (!this.connections.has(socket)) return;

		state.unsubscribe = this.events.subscribe(kinds, (event: ControlEvent) => {
			this.write(socket, event);
		});
	}

	private write(socket: Socket, value: unknown): void {
		if (socket.destroyed) return;
		try {
			socket.write(encodeNdjson(value));
		} catch {
			this.closeConnection(socket);
		}
	}

	private closeConnection(socket: Socket): void {
		const state = this.connections.get(socket);
		if (!state) return;
		this.connections.delete(socket);
		state.unsubscribe?.();
		state.unsubscribe = null;
		try {
			socket.end();
		} catch {
			// best-effort
		}
		try {
			socket.destroy();
		} catch {
			// best-effort
		}
	}
}
