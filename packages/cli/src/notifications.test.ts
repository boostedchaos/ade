import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "./client";
import { EXIT } from "./errors";
import { type RunIo, run } from "./run";
import { captureIo, type MockServer, startMockServer } from "./test-support";

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

const savedSurfaceId = process.env.ADE_SURFACE_ID;
afterEach(() => {
	if (savedSurfaceId === undefined) delete process.env.ADE_SURFACE_ID;
	else process.env.ADE_SURFACE_ID = savedSurfaceId;
});

/** Answers with a canned notification result for any command. */
function notificationServer(
	result: Record<string, unknown>,
): Promise<MockServer> {
	return startMockServer({
		handler: (request) => ({ id: request.id, ok: true, result }),
	});
}

describe.skipIf(skipWin)("ade notify", () => {
	it("sends title and body, and defaults the pane to $ADE_SURFACE_ID", async () => {
		delete process.env.ADE_SURFACE_ID;
		process.env.ADE_SURFACE_ID = "pane-from-env";
		const server = await notificationServer({ id: "n1", title: "Done" });
		const { io } = ioFor(server);
		try {
			expect(await run(["notify", "--title", "Done", "--body", "ok"], io)).toBe(
				EXIT.OK,
			);
			const request = server.requests.find((r) => r.cmd === "notify");
			expect(request?.args).toEqual({
				title: "Done",
				body: "ok",
				pane: "pane-from-env",
			});
		} finally {
			await server.close();
		}
	});

	it("prefers an explicit --pane over the environment", async () => {
		process.env.ADE_SURFACE_ID = "pane-from-env";
		const server = await notificationServer({ id: "n1", title: "Done" });
		const { io } = ioFor(server);
		try {
			await run(["notify", "--title", "Done", "--pane", "pane:2"], io);
			expect(server.requests.find((r) => r.cmd === "notify")?.args?.pane).toBe(
				"pane:2",
			);
		} finally {
			await server.close();
		}
	});

	it("omits pane entirely when neither is set", async () => {
		delete process.env.ADE_SURFACE_ID;
		const server = await notificationServer({ id: "n1", title: "Done" });
		const { io } = ioFor(server);
		try {
			await run(["notify", "--title", "Done"], io);
			expect(server.requests.find((r) => r.cmd === "notify")?.args).toEqual({
				title: "Done",
			});
		} finally {
			await server.close();
		}
	});

	it("is a usage error without --title", async () => {
		const { io, capture } = absentIo();
		expect(await run(["notify", "--body", "x"], io)).toBe(EXIT.USAGE);
		expect(capture.stderrText()).toContain("title");
	});

	it("exits 3 with the app closed — unlike agent-event, it does not fail silently", async () => {
		delete process.env.ADE_SURFACE_ID;
		const { io } = absentIo();
		expect(await run(["notify", "--title", "x"], io)).toBe(EXIT.NOT_RUNNING);
	});
});

describe.skipIf(skipWin)("ade list-notifications", () => {
	it("sends no args by default and prints a table", async () => {
		const server = await notificationServer({
			notifications: [
				{
					id: "n1",
					kind: "attention",
					title: "One needs input",
					paneId: "pane-1",
					createdAt: 1_700_000_000_000,
					readAt: null,
				},
			],
			unread: 1,
		});
		const { io, capture } = ioFor(server);
		try {
			expect(await run(["list-notifications"], io)).toBe(EXIT.OK);
			// The client omits an empty `args` object entirely (client.ts:208), so
			// "no filter" is an absent key rather than `{}`.
			expect(
				server.requests.find((r) => r.cmd === "list-notifications")?.args,
			).toBeUndefined();
			const text = capture.stdoutText();
			expect(text).toContain("UNREAD");
			expect(text).toContain("One needs input");
		} finally {
			await server.close();
		}
	});

	it("sends unread:true for --unread", async () => {
		const server = await notificationServer({ notifications: [], unread: 0 });
		const { io, capture } = ioFor(server);
		try {
			await run(["list-notifications", "--unread"], io);
			expect(
				server.requests.find((r) => r.cmd === "list-notifications")?.args,
			).toEqual({ unread: true });
			expect(capture.stdoutText()).toContain("No notifications.");
		} finally {
			await server.close();
		}
	});
});

describe.skipIf(skipWin)("ade mark-notification-read", () => {
	it("sends the id", async () => {
		const server = await notificationServer({ marked: 1, all: false });
		const { io, capture } = ioFor(server);
		try {
			expect(await run(["mark-notification-read", "n1"], io)).toBe(EXIT.OK);
			expect(
				server.requests.find((r) => r.cmd === "mark-notification-read")?.args,
			).toEqual({ id: "n1" });
			expect(capture.stdoutText()).toContain("Marked read.");
		} finally {
			await server.close();
		}
	});

	it("sends all:true for --all", async () => {
		const server = await notificationServer({ marked: 4, all: true });
		const { io, capture } = ioFor(server);
		try {
			await run(["mark-notification-read", "--all"], io);
			expect(
				server.requests.find((r) => r.cmd === "mark-notification-read")?.args,
			).toEqual({ all: true });
			expect(capture.stdoutText()).toContain("Marked 4 notifications read.");
		} finally {
			await server.close();
		}
	});

	it("rejects an id together with --all", async () => {
		const { io } = absentIo();
		expect(await run(["mark-notification-read", "n1", "--all"], io)).toBe(
			EXIT.USAGE,
		);
	});

	it("rejects neither an id nor --all", async () => {
		const { io } = absentIo();
		expect(await run(["mark-notification-read"], io)).toBe(EXIT.USAGE);
	});
});

describe.skipIf(skipWin)("ade jump-to-unread", () => {
	it("reports the pane it focused", async () => {
		const server = await notificationServer({
			jumped: true,
			paneId: "pane-2",
			remaining: 2,
		});
		const { io, capture } = ioFor(server);
		try {
			expect(await run(["jump-to-unread"], io)).toBe(EXIT.OK);
			expect(capture.stdoutText()).toContain("Focused pane pane-2");
		} finally {
			await server.close();
		}
	});

	it("says so when nothing is waiting", async () => {
		const server = await notificationServer({ jumped: false, paneId: null });
		const { io, capture } = ioFor(server);
		try {
			await run(["jump-to-unread"], io);
			expect(capture.stdoutText()).toContain("No panes are waiting on you.");
		} finally {
			await server.close();
		}
	});
});

describe("registry", () => {
	it("no longer lists the four Phase 3 verbs as stubs", async () => {
		const { COMMANDS } = await import("./commands");
		for (const name of [
			"notify",
			"list-notifications",
			"mark-notification-read",
			"jump-to-unread",
		]) {
			const command = COMMANDS.find((c) => c.name === name);
			expect(command).toBeDefined();
			expect(command?.kind).not.toBe("stub");
			expect(command?.group).toBe("Notifications");
		}
	});
});
