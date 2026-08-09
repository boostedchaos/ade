import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "./client";
import { EXIT } from "./errors";
import { type RunIo, run } from "./run";
import { captureIo, startMockServer } from "./test-support";

const skipWin = process.platform === "win32";

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

/** Points the CLI at a socket path that does not exist. */
function absentIo() {
	const capture = captureIo();
	return {
		capture,
		io: {
			...capture,
			clientOptions: {
				socketPath: join(tmpdir(), "ade-cli-absent", "control.sock"),
				tokenPath: join(tmpdir(), "ade-cli-absent", "control.token"),
			},
		} satisfies RunIo,
	};
}

const savedEnv = { ...process.env };
afterEach(() => {
	process.env.ADE_SURFACE_ID = savedEnv.ADE_SURFACE_ID;
	process.env.ADE_WORKSPACE_ID = savedEnv.ADE_WORKSPACE_ID;
	if (savedEnv.ADE_SURFACE_ID === undefined) delete process.env.ADE_SURFACE_ID;
	if (savedEnv.ADE_WORKSPACE_ID === undefined) {
		delete process.env.ADE_WORKSPACE_ID;
	}
});

/**
 * `ade agent-event` runs from inside a Claude Code hook on every prompt and
 * every tool call, in and out of ADE. It must NEVER be the reason an agent
 * breaks, which means: always exit 0, never write to stdout or stderr.
 */
describe.skipIf(skipWin)("agent-event never breaks Claude Code", () => {
	it("exits 0 silently when the app is not running", async () => {
		process.env.ADE_SURFACE_ID = "pane-1";
		const { io, capture } = absentIo();
		expect(await run(["agent-event", "--event", "Stop"], io)).toBe(EXIT.OK);
		expect(capture.stdoutText()).toBe("");
		expect(capture.stderrText()).toBe("");
	});

	it("exits 0 silently when ADE_SURFACE_ID is not set — i.e. outside ADE", async () => {
		delete process.env.ADE_SURFACE_ID;
		const server = await startMockServer();
		const { io, capture } = ioFor(server);
		expect(await run(["agent-event", "--event", "Stop"], io)).toBe(EXIT.OK);
		expect(capture.stdoutText()).toBe("");
		expect(capture.stderrText()).toBe("");
		// It must not even have opened a connection.
		expect(server.requests).toHaveLength(0);
		await server.close();
	});

	it("exits 0 silently when the server refuses the command", async () => {
		process.env.ADE_SURFACE_ID = "pane-1";
		const server = await startMockServer({
			handler: (request) =>
				request.cmd === "agent-event"
					? {
							id: request.id,
							ok: false,
							error: { code: "INTERNAL", message: "nope" },
						}
					: undefined,
		});
		const { io, capture } = ioFor(server);
		expect(await run(["agent-event", "--event", "Stop"], io)).toBe(EXIT.OK);
		expect(capture.stderrText()).toBe("");
		await server.close();
	});

	it("exits 0 silently when --event is missing", async () => {
		process.env.ADE_SURFACE_ID = "pane-1";
		const { io, capture } = absentIo();
		expect(await run(["agent-event"], io)).toBe(EXIT.OK);
		expect(capture.stderrText()).toBe("");
	});

	it("sends the pane and workspace from the environment", async () => {
		process.env.ADE_SURFACE_ID = "pane-7";
		process.env.ADE_WORKSPACE_ID = "ws-7";
		const server = await startMockServer();
		const { io } = ioFor(server);

		expect(
			await run(
				[
					"agent-event",
					"--event",
					"PreToolUse",
					"--session-id",
					"s1",
					"--transcript-path",
					"/tmp/t.jsonl",
				],
				io,
			),
		).toBe(EXIT.OK);

		const sent = server.requests.find((r) => r.cmd === "agent-event");
		expect(sent?.args).toEqual({
			surfaceId: "pane-7",
			workspaceId: "ws-7",
			event: "PreToolUse",
			sessionId: "s1",
			transcriptPath: "/tmp/t.jsonl",
		});
		await server.close();
	});

	it("prefers an explicit --surface-id over the environment", async () => {
		process.env.ADE_SURFACE_ID = "pane-env";
		const server = await startMockServer();
		const { io } = ioFor(server);
		await run(
			["agent-event", "--event", "Stop", "--surface-id", "pane-arg"],
			io,
		);
		const sent = server.requests.find((r) => r.cmd === "agent-event");
		expect((sent?.args as { surfaceId: string }).surfaceId).toBe("pane-arg");
		await server.close();
	});

	it("still prints its own help", async () => {
		const capture = captureIo();
		expect(await run(["agent-event", "--help"], capture)).toBe(EXIT.OK);
		expect(capture.stdoutText()).toContain("ADE_SURFACE_ID");
	});
});

describe.skipIf(skipWin)("agent-sessions", () => {
	it("renders lastActivityAt as a timestamp", async () => {
		const server = await startMockServer({
			handler: (request) => ({
				id: request.id,
				ok: true,
				result: {
					sessions: [
						{
							surfaceId: "pane-1",
							state: "working",
							lastActivityAt: 1_700_000_000_000,
						},
					],
				},
			}),
		});
		const { io, capture } = ioFor(server);
		expect(await run(["agent-sessions"], io)).toBe(EXIT.OK);
		expect(capture.stdoutText()).toContain("pane-1");
		expect(capture.stdoutText()).toContain("2023-11-14T");
		await server.close();
	});

	it("says so when nothing is tracked", async () => {
		const server = await startMockServer({
			handler: (request) => ({
				id: request.id,
				ok: true,
				result: { sessions: [] },
			}),
		});
		const { io, capture } = ioFor(server);
		expect(await run(["agent-sessions"], io)).toBe(EXIT.OK);
		expect(capture.stdoutText()).toContain("No agent sessions tracked.");
		await server.close();
	});
});

describe.skipIf(skipWin)("hooks", () => {
	it("dispatches setup and prints the backup path", async () => {
		const server = await startMockServer({
			handler: (request) => ({
				id: request.id,
				ok: true,
				result: {
					agent: "claude",
					settingsPath: "/home/u/.ade/hooks/claude-settings.json",
					changed: true,
					backupPath: "/home/u/.ade/hooks/claude-settings.json.old.bak",
					registered: ["Stop", "SessionEnd"],
					missing: [],
				},
			}),
		});
		const { io, capture } = ioFor(server);
		expect(await run(["hooks", "setup", "claude"], io)).toBe(EXIT.OK);
		expect(server.requests.find((r) => r.cmd === "hooks-setup")).toBeDefined();
		expect(capture.stdoutText()).toContain("Wrote hooks file");
		expect(capture.stdoutText()).toContain("claude-settings.json.old.bak");
		expect(capture.stdoutText()).toContain("Events wired (2)");
		await server.close();
	});

	it("reports missing coverage from status", async () => {
		const server = await startMockServer({
			handler: (request) => ({
				id: request.id,
				ok: true,
				result: {
					agent: "claude",
					settingsPath: "/home/u/.ade/hooks/claude-settings.json",
					present: true,
					supported: true,
					registered: ["Stop"],
					missing: ["SessionStart", "SessionEnd"],
				},
			}),
		});
		const { io, capture } = ioFor(server);
		expect(await run(["hooks", "status"], io)).toBe(EXIT.OK);
		expect(capture.stdoutText()).toContain("reachable");
		expect(capture.stdoutText()).toContain("Events MISSING (2)");
		await server.close();
	});

	it("exits 2 for an unknown subcommand", async () => {
		const server = await startMockServer();
		const { io } = ioFor(server);
		expect(await run(["hooks", "frobnicate"], io)).toBe(EXIT.USAGE);
		await server.close();
	});

	it("still answers `status` from disk with the app closed", async () => {
		const home = mkdtempSync(join(tmpdir(), "ade-hooks-home-"));
		const savedHome = process.env.HOME;
		try {
			// getAdeDirName() reads SUPERSET_WORKSPACE_NAME; the default is ".ade".
			process.env.HOME = home;
			const dir = join(home, ".ade", "hooks");
			require("node:fs").mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "claude-settings.json"),
				JSON.stringify({
					hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] },
				}),
			);

			const { io, capture } = absentIo();
			expect(await run(["hooks", "status"], io)).toBe(EXIT.OK);
			expect(capture.stdoutText()).toContain("NOT reachable");
			expect(capture.stdoutText()).toContain("Hooks file: present");
			expect(capture.stdoutText()).toContain("Events MISSING");
		} finally {
			process.env.HOME = savedHome;
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("keeps the exit-3 contract for `setup` with the app closed", async () => {
		const { io, capture } = absentIo();
		expect(await run(["hooks", "setup"], io)).toBe(EXIT.NOT_RUNNING);
		expect(capture.stderrText()).toContain("ADE app is not running");
	});
});
