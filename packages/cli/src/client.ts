/**
 * Control-socket client. Wire contract: docs/specs/mission-control/PROTOCOL.md.
 *
 * One JSON object per \n-terminated line, both directions. First line is the
 * hello handshake carrying the token from ~/.ade/control.token. Responses are
 * {id, ok:true, result} | {id, ok:false, error:{code,message}} — note `result`,
 * not the terminal-host daemon's `payload` (deliberate divergence, PROTOCOL.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { CliError, EXIT, notRunningError, serverError } from "./errors";
import {
	getControlSocketPath,
	getControlTokenPath,
	isNamedPipePath,
} from "./socket-path";

export const CLIENT_NAME = "ade-cli";

export interface ControlSuccess {
	id: string;
	ok: true;
	result?: unknown;
}

export interface ControlFailure {
	id: string;
	ok: false;
	error: { code: string; message: string };
}

export type ControlResponse = ControlSuccess | ControlFailure;

export interface ControlEvent {
	event: string;
	ts?: string;
	data?: unknown;
}

export interface ClientOptions {
	socketPath?: string;
	tokenPath?: string;
	/** Value used in the hello handshake's `client` field. */
	clientId?: string;
}

/** Splits an NDJSON byte stream into parsed objects. */
export class NdjsonParser {
	private buffer = "";

	parse(chunk: string): unknown[] {
		this.buffer += chunk;
		const out: unknown[] = [];
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (line.trim()) {
				try {
					out.push(JSON.parse(line));
				} catch {
					// A malformed line is the server's problem; skip it rather than
					// killing a long-lived event stream.
				}
			}
			index = this.buffer.indexOf("\n");
		}
		return out;
	}
}

function isResponse(value: unknown): value is ControlResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		"ok" in value
	);
}

function isEvent(value: unknown): value is ControlEvent {
	return typeof value === "object" && value !== null && "event" in value;
}

/** Connection failures that mean "the app isn't running", not "it broke". */
function isNotRunning(err: NodeJS.ErrnoException): boolean {
	return (
		err.code === "ENOENT" ||
		err.code === "ECONNREFUSED" ||
		err.code === "EACCES"
	);
}

export function readToken(tokenPath: string): string {
	let raw: string;
	try {
		raw = readFileSync(tokenPath, "utf8");
	} catch {
		throw notRunningError();
	}
	const token = raw.trim();
	if (!token) throw notRunningError();
	return token;
}

export class ControlClient {
	readonly socketPath: string;
	readonly tokenPath: string;
	private readonly clientId: string;
	private socket: Socket | null = null;
	private readonly parser = new NdjsonParser();
	private nextId = 1;
	private readonly pending = new Map<
		string,
		{ resolve: (r: ControlResponse) => void; reject: (e: Error) => void }
	>();
	private onEvent: ((event: ControlEvent) => void) | null = null;
	private onClose: ((err?: Error) => void) | null = null;
	private closed = false;

	constructor(options: ClientOptions = {}) {
		this.socketPath = options.socketPath ?? getControlSocketPath();
		this.tokenPath = options.tokenPath ?? getControlTokenPath();
		this.clientId = options.clientId ?? CLIENT_NAME;
	}

	/** Connects and performs the hello handshake. Throws CliError on failure. */
	async connect(): Promise<{ protocol?: number; app?: string }> {
		// Cheap pre-check on posix: a missing socket file is the common case
		// (app not running) and avoids a connect() round trip. Named pipes have
		// no filesystem entry, so only the connect attempt can tell us.
		if (!isNamedPipePath(this.socketPath) && !existsSync(this.socketPath)) {
			throw notRunningError();
		}
		const token = readToken(this.tokenPath);

		this.socket = await new Promise<Socket>((resolve, reject) => {
			const socket = connect(this.socketPath);
			const onError = (err: NodeJS.ErrnoException) => {
				socket.destroy();
				reject(
					isNotRunning(err)
						? notRunningError()
						: new CliError(
								EXIT.SERVER_ERROR,
								`Failed to connect to control socket: ${err.message}`,
							),
				);
			};
			socket.once("error", onError);
			socket.once("connect", () => {
				socket.removeListener("error", onError);
				resolve(socket);
			});
		});

		this.socket.setEncoding("utf8");
		this.socket.on("data", (chunk: string) => this.handleChunk(chunk));
		this.socket.on("error", (err) => this.fail(err));
		this.socket.on("close", () => this.fail());

		const hello = await this.send("hello", undefined, { token });
		if (!hello.ok) {
			throw serverError(hello.error.message, hello.error.code);
		}
		const result = (hello.result ?? {}) as { protocol?: number; app?: string };
		return result;
	}

	private handleChunk(chunk: string): void {
		for (const message of this.parser.parse(chunk)) {
			if (isResponse(message)) {
				const waiter = this.pending.get(message.id);
				if (waiter) {
					this.pending.delete(message.id);
					waiter.resolve(message);
				}
				continue;
			}
			if (isEvent(message)) this.onEvent?.(message);
		}
	}

	private fail(err?: Error): void {
		if (this.closed) return;
		this.closed = true;
		const error =
			err ?? new CliError(EXIT.SERVER_ERROR, "Control socket closed");
		for (const [, waiter] of this.pending) waiter.reject(error);
		this.pending.clear();
		this.onClose?.(err);
	}

	/** Sends one request and resolves with the server's response line. */
	send(
		cmd: string,
		args?: Record<string, unknown>,
		extra?: Record<string, unknown>,
	): Promise<ControlResponse> {
		const socket = this.socket;
		if (!socket) {
			return Promise.reject(
				new CliError(EXIT.SERVER_ERROR, "Not connected to control socket"),
			);
		}
		const id = String(this.nextId++);
		const payload: Record<string, unknown> = { id, cmd, ...extra };
		if (args && Object.keys(args).length > 0) payload.args = args;
		if (cmd === "hello") payload.client = this.clientId;

		return new Promise<ControlResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			socket.write(`${JSON.stringify(payload)}\n`, (err) => {
				if (err) {
					this.pending.delete(id);
					reject(new CliError(EXIT.SERVER_ERROR, err.message));
				}
			});
		});
	}

	/** Sends a request and returns `result`, throwing CliError on `ok:false`. */
	async request(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
		const response = await this.send(cmd, args);
		if (!response.ok) {
			throw serverError(response.error.message, response.error.code);
		}
		return response.result;
	}

	/** Flips the connection into event-stream mode (PROTOCOL.md "Events"). */
	async subscribe(
		kinds: string[],
		handler: (event: ControlEvent) => void,
	): Promise<void> {
		this.onEvent = handler;
		await this.request("subscribe", { kinds });
	}

	setCloseHandler(handler: (err?: Error) => void): void {
		this.onClose = handler;
	}

	close(): void {
		this.closed = true;
		this.socket?.end();
		this.socket?.destroy();
		this.socket = null;
	}
}
