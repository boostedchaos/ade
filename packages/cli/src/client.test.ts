import { describe, expect, it } from "bun:test";
import { ControlClient, NdjsonParser } from "./client";
import { CliError, EXIT } from "./errors";
import { startMockServer, TEST_TOKEN } from "./test-support";

// Unix-socket paths do not exist on win32; the named-pipe leg is exercised by
// the pure path tests in socket-path.test.ts.
const skipWin = process.platform === "win32";

async function connected(server: Awaited<ReturnType<typeof startMockServer>>) {
	const client = new ControlClient({
		socketPath: server.socketPath,
		tokenPath: server.tokenPath,
	});
	await client.connect();
	return client;
}

describe("NdjsonParser", () => {
	it("splits complete lines", () => {
		const parser = new NdjsonParser();
		expect(parser.parse('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("buffers a split line across chunks", () => {
		const parser = new NdjsonParser();
		expect(parser.parse('{"a":')).toEqual([]);
		expect(parser.parse("1}\n")).toEqual([{ a: 1 }]);
	});

	it("skips a malformed line instead of throwing", () => {
		const parser = new NdjsonParser();
		expect(parser.parse('not json\n{"a":1}\n')).toEqual([{ a: 1 }]);
	});
});

describe.skipIf(skipWin)("ControlClient", () => {
	it("sends hello with the token as its first line", async () => {
		const server = await startMockServer();
		const client = await connected(server);
		client.close();

		const hello = server.requests[0];
		expect(hello?.cmd).toBe("hello");
		expect(hello?.token).toBe(TEST_TOKEN);
		expect(hello?.client).toContain("ade-cli");
		expect(hello?.id).toBe("1");
		await server.close();
	});

	it("returns the handshake result", async () => {
		const server = await startMockServer();
		const client = new ControlClient({
			socketPath: server.socketPath,
			tokenPath: server.tokenPath,
		});
		expect(await client.connect()).toEqual({ protocol: 1, app: "0.4.0-test" });
		client.close();
		await server.close();
	});

	it("frames one request per line and matches responses by id", async () => {
		const server = await startMockServer({
			handler: (request) => ({
				id: request.id,
				ok: true,
				result: { cmd: request.cmd, id: request.id },
			}),
		});
		const client = await connected(server);
		const [first, second] = await Promise.all([
			client.request("list-panes", {}),
			client.request("list-tabs", {}),
		]);
		expect(first).toEqual({ cmd: "list-panes", id: "2" });
		expect(second).toEqual({ cmd: "list-tabs", id: "3" });
		client.close();
		await server.close();
	});

	it("omits args when the command has none", async () => {
		const server = await startMockServer();
		const client = await connected(server);
		await client.request("list-workspaces", {});
		expect(server.requests[1]).toEqual({
			id: "2",
			cmd: "list-workspaces",
		});
		client.close();
		await server.close();
	});

	it("throws a server error carrying the protocol error code", async () => {
		const server = await startMockServer({
			handler: (request) => ({
				id: request.id,
				ok: false,
				error: { code: "NOT_FOUND", message: "no such pane" },
			}),
		});
		const client = await connected(server);
		const error = await client.request("close-pane", {}).catch((e) => e);
		expect(error).toBeInstanceOf(CliError);
		expect((error as CliError).code).toBe(EXIT.SERVER_ERROR);
		expect((error as CliError).serverCode).toBe("NOT_FOUND");
		client.close();
		await server.close();
	});

	it("fails the handshake with exit 1 on a bad token", async () => {
		const server = await startMockServer({ token: "correct-token" });
		// Rewrite the token file so the handshake presents the wrong value.
		await Bun.write(server.tokenPath, "wrong-token");
		const bad = new ControlClient({
			socketPath: server.socketPath,
			tokenPath: server.tokenPath,
		});
		const error = await bad.connect().catch((e) => e);
		expect(error).toBeInstanceOf(CliError);
		expect((error as CliError).code).toBe(EXIT.SERVER_ERROR);
		expect((error as CliError).serverCode).toBe("AUTH_FAILED");
		bad.close();
		await server.close();
	});

	it("exits 3 when the socket file is absent", async () => {
		const server = await startMockServer();
		await server.close();
		const client = new ControlClient({
			socketPath: server.socketPath,
			tokenPath: server.tokenPath,
		});
		const error = await client.connect().catch((e) => e);
		expect((error as CliError).code).toBe(EXIT.NOT_RUNNING);
		expect((error as CliError).message).toBe(
			"ADE app is not running (no control socket)",
		);
	});

	it("exits 3 when the token file is absent", async () => {
		const server = await startMockServer({ omitTokenFile: true });
		const client = new ControlClient({
			socketPath: server.socketPath,
			tokenPath: server.tokenPath,
		});
		const error = await client.connect().catch((e) => e);
		expect((error as CliError).code).toBe(EXIT.NOT_RUNNING);
		await server.close();
	});

	it("delivers events after subscribe", async () => {
		const server = await startMockServer();
		const client = await connected(server);
		const seen: unknown[] = [];
		await client.subscribe(["*"], (event) => seen.push(event));
		server.connections.at(-1)?.emit("pane-created", { paneId: "p1" });
		await Bun.sleep(20);
		expect(seen).toEqual([
			{
				event: "pane-created",
				ts: "2026-08-09T00:00:00Z",
				data: { paneId: "p1" },
			},
		]);
		client.close();
		await server.close();
	});
});
