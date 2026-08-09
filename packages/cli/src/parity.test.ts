/**
 * Phase 5b: `ade todo`, `ade browser`, `ade set-status`, `ade set-progress`.
 *
 * Wire-shape assertions here are pinned against the server handlers in
 * packages/control-plane/src/commands/{todos,browser,status}.ts — the arg KEYS
 * are the contract, and a rename on either side is exactly the drift that cost
 * a round trip in Phase 1.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommandArgs } from "./args";
import { ControlClient } from "./client";
import type { WireRequest } from "./command";
import { findCommand } from "./commands";
import { CliError, EXIT } from "./errors";
import { type RunIo, run } from "./run";
import { captureIo, type MockServer, startMockServer } from "./test-support";

const skipWin = process.platform === "win32";

function build(name: string, argv: string[]): WireRequest {
	const command = findCommand(name);
	if (!command?.build) throw new Error(`no buildable command: ${name}`);
	const input = parseCommandArgs(
		argv,
		command.options ?? [],
		command.positionals ?? [],
	);
	return command.build(input);
}

function usageCode(name: string, argv: string[]): number {
	try {
		build(name, argv);
	} catch (err) {
		if (err instanceof CliError) return err.code;
		throw err;
	}
	throw new Error(`expected ${name} ${argv.join(" ")} to fail`);
}

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

function serverReturning(result: unknown): Promise<MockServer> {
	return startMockServer({
		handler: (request) => ({ id: request.id, ok: true, result }),
	});
}

const savedSurfaceId = process.env.ADE_SURFACE_ID;
afterEach(() => {
	if (savedSurfaceId === undefined) delete process.env.ADE_SURFACE_ID;
	else process.env.ADE_SURFACE_ID = savedSurfaceId;
});

describe("ade todo — arg parsing", () => {
	it("maps each subcommand onto its own wire command", () => {
		expect(build("todo", ["add", "write the docs"]).cmd).toBe("todo-add");
		expect(build("todo", ["list"]).cmd).toBe("todo-list");
		expect(build("todo", ["start", "t1"]).cmd).toBe("todo-start");
		expect(build("todo", ["done", "t1"]).cmd).toBe("todo-done");
		expect(build("todo", ["rm", "t1"]).cmd).toBe("todo-rm");
	});

	it("defaults --workspace to focused and joins a multi-word title", () => {
		expect(build("todo", ["add", "write", "the", "docs"]).args).toEqual({
			workspace: "focused",
			title: "write the docs",
		});
	});

	it("passes an explicit workspace ref through", () => {
		expect(build("todo", ["list", "--workspace", "workspace:2"]).args).toEqual({
			workspace: "workspace:2",
		});
	});

	it("sends --state only when given, and validates it", () => {
		expect(build("todo", ["list", "--state", "completed"]).args).toEqual({
			workspace: "focused",
			state: "completed",
		});
		expect(usageCode("todo", ["list", "--state", "almost"])).toBe(EXIT.USAGE);
	});

	it("sends only the id for the mutating verbs", () => {
		expect(build("todo", ["done", "abc-123"]).args).toEqual({ id: "abc-123" });
	});

	it("rejects a missing or unknown subcommand", () => {
		expect(usageCode("todo", [])).toBe(EXIT.USAGE);
		expect(usageCode("todo", ["finish", "t1"])).toBe(EXIT.USAGE);
	});

	it("rejects add with no title and start/done/rm with no id", () => {
		expect(usageCode("todo", ["add"])).toBe(EXIT.USAGE);
		expect(usageCode("todo", ["start"])).toBe(EXIT.USAGE);
		expect(usageCode("todo", ["done"])).toBe(EXIT.USAGE);
		expect(usageCode("todo", ["rm"])).toBe(EXIT.USAGE);
	});

	it("rejects a stray positional after list", () => {
		expect(usageCode("todo", ["list", "pending"])).toBe(EXIT.USAGE);
	});
});

describe.skipIf(skipWin)("ade todo — output", () => {
	it("prints a table plus a counts summary", async () => {
		const server = await serverReturning({
			workspaceId: "w1",
			todos: [
				{ id: "t1", title: "first", state: "pending" },
				{ id: "t2", title: "second", state: "completed" },
			],
			counts: { pending: 1, "in-progress": 0, completed: 1 },
		});
		const { io, capture } = ioFor(server);
		expect(await run(["todo", "list"], io)).toBe(EXIT.OK);
		const out = capture.stdoutText();
		expect(out).toContain("TITLE");
		expect(out).toContain("second");
		expect(out).toContain("1 pending, 0 in-progress, 1 completed");
		await server.close();
	});

	it("says so when a workspace has no todos", async () => {
		const server = await serverReturning({
			workspaceId: "w1",
			todos: [],
			counts: { pending: 0, "in-progress": 0, completed: 0 },
		});
		const { io, capture } = ioFor(server);
		await run(["todo", "list"], io);
		expect(capture.stdoutText()).toContain("No todos.");
		await server.close();
	});

	it("confirms an add with the returned id and state", async () => {
		const server = await serverReturning({
			id: "t9",
			title: "ship it",
			state: "pending",
		});
		const { io, capture } = ioFor(server);
		expect(await run(["todo", "add", "ship it"], io)).toBe(EXIT.OK);
		expect(capture.stdoutText()).toBe("Added t9: ship it [pending]");
		await server.close();
	});

	it("maps a server NOT_FOUND onto exit 1", async () => {
		const server = await startMockServer({
			handler: (request) => ({
				id: request.id,
				ok: false,
				error: { code: "NOT_FOUND", message: "No todo with id nope" },
			}),
		});
		const { io, capture } = ioFor(server);
		expect(await run(["todo", "done", "nope"], io)).toBe(EXIT.SERVER_ERROR);
		expect(capture.stderrText()).toContain("NOT_FOUND");
		await server.close();
	});
});

describe("ade browser — arg parsing", () => {
	it("maps each verb onto browser-<verb>", () => {
		for (const verb of [
			"navigate",
			"click",
			"type",
			"fill",
			"screenshot",
			"info",
		]) {
			const argv = [verb, "--pane", "pane:2"];
			if (verb === "navigate") argv.push("--url", "https://example.com");
			if (verb === "click") argv.push("--selector", "#go");
			if (verb === "type") argv.push("--selector", "#q", "--text", "hi");
			if (verb === "fill") argv.push("--fields", '{"#q":"hi"}');
			expect(build("browser", argv).cmd).toBe(`browser-${verb}`);
		}
		expect(build("browser", ["capabilities"]).cmd).toBe("browser-capabilities");
		expect(build("browser", ["open", "--url", "https://e.com"]).cmd).toBe(
			"browser-open",
		);
	});

	it("requires --url for open, and leaves direction/focus to the server default", () => {
		expect(build("browser", ["open", "--url", "https://e.com"]).args).toEqual({
			url: "https://e.com",
		});
		expect(usageCode("browser", ["open"])).toBe(EXIT.USAGE);
	});

	it("passes --direction and --focus through when given", () => {
		expect(
			build("browser", [
				"open",
				"--url",
				"https://e.com",
				"--direction",
				"left",
				"--focus",
				"false",
			]).args,
		).toEqual({ url: "https://e.com", direction: "left", focus: false });
	});

	it("requires --pane for every verb that acts on an existing pane", () => {
		expect(usageCode("browser", ["navigate", "--url", "https://e.com"])).toBe(
			EXIT.USAGE,
		);
		expect(usageCode("browser", ["click", "--selector", "#go"])).toBe(
			EXIT.USAGE,
		);
		expect(usageCode("browser", ["info"])).toBe(EXIT.USAGE);
	});

	it("does not require --pane for open or capabilities", () => {
		expect(build("browser", ["capabilities"]).args).toEqual({});
		expect(build("browser", ["open", "--url", "https://e.com"]).args.pane).toBe(
			undefined,
		);
	});

	// The server reads `text` directly rather than through requireString for
	// exactly this case: "" means "clear the field", and dropping it would turn
	// a clear into a BAD_REQUEST.
	it("keeps an EMPTY --text on the wire", () => {
		expect(
			build("browser", [
				"type",
				"--pane",
				"pane:2",
				"--selector",
				"#q",
				"--text",
				"",
			]).args,
		).toEqual({ pane: "pane:2", selector: "#q", text: "" });
	});

	it("still rejects a missing --text", () => {
		expect(
			usageCode("browser", ["type", "--pane", "pane:2", "--selector", "#q"]),
		).toBe(EXIT.USAGE);
	});

	it("parses --fields into an object", () => {
		expect(
			build("browser", [
				"fill",
				"--pane",
				"pane:2",
				"--fields",
				'{"#user":"kyle","#pw":"pw"}',
			]).args,
		).toEqual({ pane: "pane:2", fields: { "#user": "kyle", "#pw": "pw" } });
	});

	it("rejects malformed, non-object, empty and non-string --fields", () => {
		const bad = (fields: string) =>
			usageCode("browser", ["fill", "--pane", "pane:2", "--fields", fields]);
		expect(bad("not json")).toBe(EXIT.USAGE);
		expect(bad('["#a","b"]')).toBe(EXIT.USAGE);
		expect(bad("{}")).toBe(EXIT.USAGE);
		expect(bad('{"#qty":3}')).toBe(EXIT.USAGE);
		expect(bad('{"#qty":null}')).toBe(EXIT.USAGE);
	});

	it("sends --path only when given for screenshot", () => {
		expect(build("browser", ["screenshot", "--pane", "pane:2"]).args).toEqual({
			pane: "pane:2",
		});
		expect(
			build("browser", [
				"screenshot",
				"--pane",
				"pane:2",
				"--path",
				"/tmp/a.png",
			]).args,
		).toEqual({ pane: "pane:2", path: "/tmp/a.png" });
	});

	it("rejects a missing or unknown verb", () => {
		expect(usageCode("browser", [])).toBe(EXIT.USAGE);
		expect(usageCode("browser", ["scroll", "--pane", "pane:2"])).toBe(
			EXIT.USAGE,
		);
	});

	it("prints the unsupported list in --help", async () => {
		const capture = captureIo();
		expect(await run(["browser", "--help"], capture)).toBe(EXIT.OK);
		const help = capture.stdoutText();
		expect(help).toContain("NOT SUPPORTED");
		expect(help).toContain("DevTools Protocol");
		expect(help).toContain("cookie or profile import");
		expect(help).toContain("multi-pane fan-out");
	});
});

describe.skipIf(skipWin)("ade browser — output", () => {
	it("prints the screenshot path the server returned", async () => {
		const server = await serverReturning({
			paneId: "p2",
			path: "/tmp/shot-1.png",
		});
		const { io, capture } = ioFor(server);
		expect(await run(["browser", "screenshot", "--pane", "pane:2"], io)).toBe(
			EXIT.OK,
		);
		expect(capture.stdoutText()).toBe("/tmp/shot-1.png");
		await server.close();
	});

	it("prints capabilities including what is unsupported", async () => {
		const server = await serverReturning({
			available: true,
			supported: ["open", "navigate"],
			unsupported: ["cdp: no Chrome DevTools Protocol attachment"],
		});
		const { io, capture } = ioFor(server);
		await run(["browser", "capabilities"], io);
		expect(capture.stdoutText()).toContain("available");
		expect(capture.stdoutText()).toContain("cdp:");
		await server.close();
	});

	it("reports how many fields were filled", async () => {
		const server = await serverReturning({
			paneId: "p2",
			filled: ["#user", "#pw"],
			count: 2,
		});
		const { io, capture } = ioFor(server);
		await run(
			[
				"browser",
				"fill",
				"--pane",
				"pane:2",
				"--fields",
				'{"#user":"k","#pw":"p"}',
			],
			io,
		);
		expect(capture.stdoutText()).toBe("Filled 2 field(s): #user, #pw");
		await server.close();
	});

	it("maps a server UNSUPPORTED onto exit 1", async () => {
		const server = await startMockServer({
			handler: (request) => ({
				id: request.id,
				ok: false,
				error: {
					code: "UNSUPPORTED",
					message: "This ADE build has no browser panes",
				},
			}),
		});
		const { io, capture } = ioFor(server);
		expect(await run(["browser", "info", "--pane", "pane:2"], io)).toBe(
			EXIT.SERVER_ERROR,
		);
		expect(capture.stderrText()).toContain("UNSUPPORTED");
		await server.close();
	});
});

describe("ade set-status / set-progress — arg parsing", () => {
	it("defaults --pane to $ADE_SURFACE_ID", () => {
		process.env.ADE_SURFACE_ID = "pane-from-env";
		expect(build("set-status", ["working"]).args).toEqual({
			pane: "pane-from-env",
			state: "working",
		});
		expect(build("set-progress", ["40"]).args).toEqual({
			pane: "pane-from-env",
			value: 40,
		});
	});

	it("lets an explicit --pane win over the environment", () => {
		process.env.ADE_SURFACE_ID = "pane-from-env";
		expect(build("set-status", ["idle", "--pane", "pane:3"]).args).toEqual({
			pane: "pane:3",
			state: "idle",
		});
	});

	it("is a usage error with neither --pane nor $ADE_SURFACE_ID", () => {
		delete process.env.ADE_SURFACE_ID;
		expect(usageCode("set-status", ["idle"])).toBe(EXIT.USAGE);
		expect(usageCode("set-progress", ["50"])).toBe(EXIT.USAGE);
	});

	it("names both ways to supply a pane in the error", () => {
		delete process.env.ADE_SURFACE_ID;
		try {
			build("set-status", ["idle"]);
		} catch (err) {
			expect((err as CliError).message).toContain("--pane");
			expect((err as CliError).message).toContain("ADE_SURFACE_ID");
		}
	});

	it("validates the state against the server's enum", () => {
		process.env.ADE_SURFACE_ID = "p1";
		for (const state of ["working", "needsInput", "idle"]) {
			expect(build("set-status", [state]).args.state).toBe(state);
		}
		expect(usageCode("set-status", ["busy"])).toBe(EXIT.USAGE);
		expect(usageCode("set-status", [])).toBe(EXIT.USAGE);
	});

	it("sends numeric progress as a number", () => {
		process.env.ADE_SURFACE_ID = "p1";
		expect(build("set-progress", ["0"]).args.value).toBe(0);
		expect(build("set-progress", ["100"]).args.value).toBe(100);
	});

	// "clear" is a word, not an absent argument: a shell variable expanding to
	// nothing must fail rather than silently wipe the bar.
	it("distinguishes `clear` from an absent value", () => {
		process.env.ADE_SURFACE_ID = "p1";
		expect(build("set-progress", ["clear"]).args.value).toBe("clear");
		expect(usageCode("set-progress", [])).toBe(EXIT.USAGE);
		expect(usageCode("set-progress", [""])).toBe(EXIT.USAGE);
	});

	it("rejects out-of-range and non-integer progress", () => {
		process.env.ADE_SURFACE_ID = "p1";
		expect(usageCode("set-progress", ["-1"])).toBe(EXIT.USAGE);
		expect(usageCode("set-progress", ["101"])).toBe(EXIT.USAGE);
		expect(usageCode("set-progress", ["40.5"])).toBe(EXIT.USAGE);
		expect(usageCode("set-progress", ["lots"])).toBe(EXIT.USAGE);
	});
});

describe.skipIf(skipWin)("ade set-status / set-progress — output", () => {
	it("reports the transition the server applied", async () => {
		const server = await serverReturning({
			paneId: "p1",
			applied: true,
			from: "working",
			to: "needsInput",
		});
		const { io, capture } = ioFor(server);
		expect(
			await run(["set-status", "needsInput", "--pane", "pane:1"], io),
		).toBe(EXIT.OK);
		expect(capture.stdoutText()).toBe("p1: working -> needsInput");
		await server.close();
	});

	it("says nothing changed when the state was already set", async () => {
		const server = await serverReturning({
			paneId: "p1",
			applied: false,
			from: null,
			to: null,
		});
		const { io, capture } = ioFor(server);
		await run(["set-status", "idle", "--pane", "pane:1"], io);
		expect(capture.stdoutText()).toContain("no change");
		await server.close();
	});

	it("distinguishes cleared progress from 0%", async () => {
		const cleared = await serverReturning({ paneId: "p1", progress: null });
		const { io: io1, capture: c1 } = ioFor(cleared);
		await run(["set-progress", "clear", "--pane", "pane:1"], io1);
		expect(c1.stdoutText()).toBe("p1: progress cleared");
		await cleared.close();

		const zero = await serverReturning({ paneId: "p1", progress: 0 });
		const { io: io2, capture: c2 } = ioFor(zero);
		await run(["set-progress", "0", "--pane", "pane:1"], io2);
		expect(c2.stdoutText()).toBe("p1: 0%");
		await zero.close();
	});

	it("sends the wire keys the server reads", async () => {
		const server = await serverReturning({ paneId: "p1", progress: 25 });
		const { io } = ioFor(server);
		await run(["set-progress", "25", "--pane", "pane:1"], io);
		expect(server.requests[1]).toEqual({
			id: "2",
			cmd: "set-progress",
			args: { pane: "pane:1", value: 25 },
		});
		await server.close();
	});
});

describe("phase 5b commands with no app running", () => {
	it("exits 3 rather than pretending to work", async () => {
		process.env.ADE_SURFACE_ID = "p1";
		for (const argv of [
			["todo", "list"],
			["browser", "info", "--pane", "pane:1"],
			["set-status", "idle"],
			["set-progress", "clear"],
		]) {
			const { io, capture } = absentIo();
			expect(await run(argv, io)).toBe(EXIT.NOT_RUNNING);
			expect(capture.stderrText()).toContain("ADE app is not running");
		}
	});
});
