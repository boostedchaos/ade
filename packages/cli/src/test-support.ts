/**
 * In-process mock control server for tests.
 *
 * It listens on a unix socket inside a fresh mkdtemp directory — never
 * ~/.ade/control.sock — so a test run can never reach the developer's live
 * app, and never depends on SUPERSET_WORKSPACE_NAME being set correctly.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MockRequest {
	id: string;
	cmd: string;
	args?: Record<string, unknown>;
	token?: string;
	client?: string;
}

export interface MockServerOptions {
	/** Token the handshake must present. Defaults to a fixed test token. */
	token?: string;
	/** Write no token file, simulating an app that never started. */
	omitTokenFile?: boolean;
	/** Answers a request. Return undefined to send nothing. */
	handler?: (
		request: MockRequest,
		conn: MockConnection,
	) => Record<string, unknown> | undefined;
}

export interface MockConnection {
	/** Pushes an event line (PROTOCOL.md "Events"). */
	emit: (event: string, data?: unknown) => void;
	/** Drops the connection, to exercise reconnect handling. */
	drop: () => void;
}

export interface MockServer {
	socketPath: string;
	tokenPath: string;
	token: string;
	/** Every request line the server received, in order. */
	requests: MockRequest[];
	/** Connections currently open, newest last. */
	connections: MockConnection[];
	close: () => Promise<void>;
}

export const TEST_TOKEN = "0123456789abcdef0123456789abcdef";

export async function startMockServer(
	options: MockServerOptions = {},
): Promise<MockServer> {
	const dir = mkdtempSync(join(tmpdir(), "ade-cli-test-"));
	const socketPath = join(dir, "control.sock");
	const tokenPath = join(dir, "control.token");
	const token = options.token ?? TEST_TOKEN;
	if (!options.omitTokenFile) {
		writeFileSync(tokenPath, token, { mode: 0o600 });
	}

	const requests: MockRequest[] = [];
	const connections: MockConnection[] = [];

	const server: Server = createServer((socket: Socket) => {
		let authed = false;
		let buffer = "";
		const write = (value: unknown) => {
			if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
		};
		const conn: MockConnection = {
			emit: (event, data) => write({ event, ts: "2026-08-09T00:00:00Z", data }),
			drop: () => socket.destroy(),
		};
		connections.push(conn);

		socket.setEncoding("utf8");
		socket.on("error", () => {});
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
				if (!line.trim()) continue;

				const request = JSON.parse(line) as MockRequest;
				requests.push(request);

				if (!authed) {
					if (request.cmd !== "hello") {
						write({
							id: request.id,
							ok: false,
							error: { code: "AUTH_REQUIRED", message: "hello first" },
						});
						socket.end();
						return;
					}
					if (request.token !== token) {
						write({
							id: request.id,
							ok: false,
							error: { code: "AUTH_FAILED", message: "bad token" },
						});
						socket.end();
						return;
					}
					authed = true;
					write({
						id: request.id,
						ok: true,
						result: { protocol: 1, app: "0.4.0-test" },
					});
					continue;
				}

				const response = options.handler?.(request, conn) ?? {
					id: request.id,
					ok: true,
					result: { echoed: request.cmd, args: request.args ?? {} },
				};
				write(response);
			}
		});
	});

	await new Promise<void>((resolve) => server.listen(socketPath, resolve));

	return {
		socketPath,
		tokenPath,
		token,
		requests,
		connections,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => {
					rmSync(dir, { recursive: true, force: true });
					resolve();
				});
			}),
	};
}

/** Collects stdout/stderr lines for a `run()` call. */
export function captureIo() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		out,
		err,
		stdout: (line: string) => out.push(line),
		stderr: (line: string) => err.push(line),
		stdoutText: () => out.join("\n"),
		stderrText: () => err.join("\n"),
	};
}
