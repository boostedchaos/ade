import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "./client";
import { EXIT } from "./errors";
import { type RunIo, run } from "./run";
import { captureIo, startMockServer } from "./test-support";

const skipWin = process.platform === "win32";

/** RunIo bound to a mock server — never touches ~/.ade. */
function ioFor(server: { socketPath: string; tokenPath: string }) {
	const capture = captureIo();
	const io: RunIo = {
		stdout: capture.stdout,
		stderr: capture.stderr,
		clientOptions: {
			socketPath: server.socketPath,
			tokenPath: server.tokenPath,
		},
		createClient: (options) => new ControlClient(options),
	};
	return { io, capture };
}

describe("help and version", () => {
	it("prints the command list with no arguments", async () => {
		const capture = captureIo();
		expect(await run([], capture)).toBe(EXIT.OK);
		expect(capture.stdoutText()).toContain("Panes / layout");
		expect(capture.stdoutText()).toContain("list-workspaces");
	});

	it("prints per-command help without connecting", async () => {
		const capture = captureIo();
		expect(await run(["new-pane", "--help"], capture)).toBe(EXIT.OK);
		expect(capture.stdoutText()).toContain("Usage: ade new-pane");
		expect(capture.stdoutText()).toContain("--direction");
	});

	it("gives every command a --help that exits 0 offline", async () => {
		const { COMMANDS } = await import("./commands");
		for (const command of COMMANDS) {
			const capture = captureIo();
			expect(await run([command.name, "--help"], capture)).toBe(EXIT.OK);
			expect(capture.stdoutText().length).toBeGreaterThan(0);
		}
	});

	it("prints the version", async () => {
		const capture = captureIo();
		expect(await run(["--version"], capture)).toBe(EXIT.OK);
		expect(capture.stdoutText()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("usage failures exit 2", () => {
	it("rejects an unknown command", async () => {
		const capture = captureIo();
		expect(await run(["teleport"], capture)).toBe(EXIT.USAGE);
		expect(capture.stderrText()).toContain("Unknown command: teleport");
	});

	it("rejects an unknown global option", async () => {
		const capture = captureIo();
		expect(await run(["--wat"], capture)).toBe(EXIT.USAGE);
	});

	it("rejects a missing required option before connecting", async () => {
		const capture = captureIo();
		expect(await run(["new-pane"], capture)).toBe(EXIT.USAGE);
		expect(capture.stderrText()).toContain("--direction");
	});

	// Derived from the registry, not a hand-kept list: a stub added without a
	// test would otherwise be invisible here.
	it("reports every registered stub as not yet implemented", async () => {
		const { COMMANDS } = await import("./commands");
		const stubs = COMMANDS.filter((c) => c.kind === "stub");
		// May legitimately be empty — every stub has shipped. The point is that
		// any stub that IS registered behaves, not that one must exist.
		for (const stub of stubs) {
			const capture = captureIo();
			expect(await run([stub.name, "whatever"], capture)).toBe(EXIT.USAGE);
			expect(capture.stderrText()).toContain("not yet implemented");
			expect(capture.stderrText()).toContain("Phase");
		}
	});

	it("registers a stub for every command SPEC.md lists but has not built yet", async () => {
		const { COMMANDS, findCommand } = await import("./commands");
		// hooks / agent-event / agent-sessions left this list in Phase 2; the four
		// notification verbs left it in Phase 3; claude-teams / tmux-compat left
		// it in Phase 4; todo / browser / set-status / set-progress left it in
		// Phase 5b, which is why they are asserted as BUILT below.
		// `cli` left this list in Phase 5 — parity extras; nothing SPEC.md lists
		// is still unbuilt, so the stub list is empty.
		expect(COMMANDS.filter((c) => c.kind === "stub")).toEqual([]);
		expect(findCommand("cli")?.kind).toBe("local");
		for (const name of ["todo", "browser", "set-status", "set-progress"]) {
			expect(findCommand(name)?.kind).toBe("request");
		}
	});

	it("routes the Phase 4 teams commands to local handlers, not stubs", async () => {
		const { findCommand } = await import("./commands");
		for (const name of ["claude-teams", "tmux-compat"]) {
			const command = findCommand(name);
			expect(command?.kind).toBe("local");
			expect(typeof command?.runLocal).toBe("function");
		}
	});

	it("does not read `-h` in a tmux argv as a request for help", async () => {
		// `split-window -h` means horizontal, and the generic rawArgs help sniff
		// would have swallowed it and printed usage instead of splitting.
		const capture = captureIo();
		const code = await run(
			["tmux-compat", "-V", "-h"],
			capture as unknown as Parameters<typeof run>[1],
		);
		expect(code).toBe(EXIT.OK);
		expect(capture.stdoutText()).toBe("tmux 3.4");
	});
});

describe("app not running exits 3", () => {
	it("reports a missing socket without auto-launching anything", async () => {
		const missing = join(tmpdir(), "ade-cli-absent", "control.sock");
		const capture = captureIo();
		const code = await run(["list-panes"], {
			...capture,
			clientOptions: {
				socketPath: missing,
				tokenPath: join(tmpdir(), "ade-cli-absent", "control.token"),
			},
		});
		expect(code).toBe(EXIT.NOT_RUNNING);
		expect(capture.stderrText()).toBe(
			"ADE app is not running (no control socket)",
		);
	});

	it("does not retry `events` when it has never connected", async () => {
		const capture = captureIo();
		const controller = new AbortController();
		const code = await run(["events"], {
			...capture,
			clientOptions: {
				socketPath: join(tmpdir(), "ade-cli-absent", "control.sock"),
				tokenPath: join(tmpdir(), "ade-cli-absent", "control.token"),
			},
			signal: controller.signal,
			backoff: { initial: 5, max: 10 },
		});
		expect(code).toBe(EXIT.NOT_RUNNING);
		expect(capture.stderrText()).toContain("ADE app is not running");
	});
});

describe.skipIf(skipWin)("against a mock control server", () => {
	it("exits 0 and prints a table for list-panes", async () => {
		const server = await startMockServer({
			handler: (request) => ({
				id: request.id,
				ok: true,
				result: [
					{ id: "p1", type: "terminal", focused: true },
					{ id: "p2", type: "browser", focused: false },
				],
			}),
		});
		const { io, capture } = ioFor(server);
		expect(await run(["list-panes"], io)).toBe(EXIT.OK);
		expect(capture.stdoutText()).toContain("ID");
		expect(capture.stdoutText()).toContain("p2");
		await server.close();
	});

	it("prints raw JSON with --json", async () => {
		const server = await startMockServer({
			handler: (request) => ({
				id: request.id,
				ok: true,
				result: { paneId: "p9" },
			}),
		});
		const { io, capture } = ioFor(server);
		expect(await run(["new-pane", "--direction", "right", "--json"], io)).toBe(
			EXIT.OK,
		);
		expect(JSON.parse(capture.stdoutText())).toEqual({ paneId: "p9" });
		await server.close();
	});

	it("sends the built request over the wire", async () => {
		const server = await startMockServer();
		const { io } = ioFor(server);
		await run(["send-key", "pane:2", "C-c"], io);
		expect(server.requests[1]).toEqual({
			id: "2",
			cmd: "send-key",
			args: { pane: "pane:2", key: "C-c", data: String.fromCharCode(3) },
		});
		await server.close();
	});

	it("exits 1 and reports the server's error code", async () => {
		const server = await startMockServer({
			handler: (request) => ({
				id: request.id,
				ok: false,
				error: { code: "NOT_FOUND", message: "no pane matches pane:9" },
			}),
		});
		const { io, capture } = ioFor(server);
		expect(await run(["close-pane", "pane:9"], io)).toBe(EXIT.SERVER_ERROR);
		expect(capture.stderrText()).toContain("NOT_FOUND");
		expect(capture.stderrText()).toContain("no pane matches pane:9");
		await server.close();
	});

	it("prints terminal text verbatim for read-screen", async () => {
		const server = await startMockServer({
			handler: (request) => ({
				id: request.id,
				ok: true,
				result: { text: "line one\nline two" },
			}),
		});
		const { io, capture } = ioFor(server);
		expect(await run(["read-screen", "pane:1"], io)).toBe(EXIT.OK);
		expect(capture.stdoutText()).toBe("line one\nline two");
		await server.close();
	});

	it("streams events as NDJSON and reconnects after a drop", async () => {
		const server = await startMockServer();
		const controller = new AbortController();
		const capture = captureIo();
		const io: RunIo = {
			stdout: capture.stdout,
			stderr: capture.stderr,
			clientOptions: {
				socketPath: server.socketPath,
				tokenPath: server.tokenPath,
			},
			createClient: (options) => new ControlClient(options),
			signal: controller.signal,
			backoff: { initial: 5, max: 10 },
		};
		const running = run(["events"], io);

		await Bun.sleep(50);
		expect(server.requests.some((r) => r.cmd === "subscribe")).toBe(true);
		server.connections.at(-1)?.emit("pane-created", { paneId: "p1" });
		await Bun.sleep(30);

		// Drop the connection: the stream must come back on its own.
		const connectionsBefore = server.connections.length;
		server.connections.at(-1)?.drop();
		await Bun.sleep(80);
		expect(server.connections.length).toBeGreaterThan(connectionsBefore);
		server.connections.at(-1)?.emit("pane-closed", { paneId: "p1" });
		await Bun.sleep(30);

		controller.abort();
		expect(await running).toBe(EXIT.OK);

		const lines = capture.out.map((line) => JSON.parse(line));
		expect(lines.map((l) => l.event)).toEqual(["pane-created", "pane-closed"]);
		await server.close();
	});

	it("--once exits 0 on the first drop instead of reconnecting", async () => {
		const server = await startMockServer();
		const controller = new AbortController();
		const capture = captureIo();
		const io: RunIo = {
			stdout: capture.stdout,
			stderr: capture.stderr,
			clientOptions: {
				socketPath: server.socketPath,
				tokenPath: server.tokenPath,
			},
			createClient: (options) => new ControlClient(options),
			signal: controller.signal,
			backoff: { initial: 5, max: 10 },
		};
		const running = run(["events", "--once"], io);

		await Bun.sleep(50);
		const connectionsBefore = server.connections.length;
		server.connections.at(-1)?.emit("pane-created", { paneId: "p1" });
		await Bun.sleep(30);
		server.connections.at(-1)?.drop();

		// No abort: without --once this promise would never settle, and the
		// reconnect loop would open another connection.
		expect(await running).toBe(EXIT.OK);
		expect(server.connections.length).toBe(connectionsBefore);
		expect(capture.out.map((l) => JSON.parse(l).event)).toEqual([
			"pane-created",
		]);
		controller.abort();
		await server.close();
	});

	it("--once still reports 3 when the app was never running", async () => {
		const capture = captureIo();
		const missing = join(tmpdir(), "ade-cli-absent", "control.sock");
		const code = await run(["events", "--once"], {
			stdout: capture.stdout,
			stderr: capture.stderr,
			clientOptions: { socketPath: missing, tokenPath: missing },
			backoff: { initial: 5, max: 10 },
		});
		expect(code).toBe(EXIT.NOT_RUNNING);
	});
});
