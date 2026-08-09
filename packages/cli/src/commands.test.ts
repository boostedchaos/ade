import { describe, expect, it } from "bun:test";
import { parseCommandArgs } from "./args";
import type { WireRequest } from "./command";
import { COMMANDS, findCommand } from "./commands";
import { CliError, EXIT } from "./errors";

function build(name: string, argv: string[]): WireRequest {
	const command = findCommand(name);
	if (!command) throw new Error(`no such command: ${name}`);
	if (!command.build) throw new Error(`${name} has no build()`);
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

describe("registry", () => {
	it("has unique command names", () => {
		const names = COMMANDS.map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("gives every command a summary and a group", () => {
		for (const command of COMMANDS) {
			expect(command.summary.length).toBeGreaterThan(0);
			expect(command.group.length).toBeGreaterThan(0);
		}
	});

	it("gives every non-stub command a build()", () => {
		for (const command of COMMANDS) {
			if (command.kind === "stub") continue;
			expect(typeof command.build).toBe("function");
		}
	});

	it("maps CLI verbs 1:1 onto wire commands, except events", () => {
		// Positionals that are not targets need a value the command accepts.
		const samples: Record<string, string> = {
			key: "Enter",
			text: "hi",
			subcommand: "status",
		};
		// `hooks` is the one verb that is a command GROUP, not a command: its
		// subcommands dispatch to `hooks-setup` / `hooks-status`. Everything else
		// must keep the 1:1 property, which is what this test protects.
		const NOT_ONE_TO_ONE = new Set(["hooks"]);
		// agent-event reads the pane from the environment ADE injects.
		process.env.ADE_SURFACE_ID = "pane-test";
		for (const command of COMMANDS) {
			if (!command.build || command.kind === "stream") continue;
			if (NOT_ONE_TO_ONE.has(command.name)) continue;
			const positionals = (command.positionals ?? []).map(
				(p) => samples[p.name] ?? "focused",
			);
			const required = (command.options ?? []).filter((o) => o.required);
			const argv = [...positionals];
			for (const option of required) {
				argv.push(`--${option.name}`, option.choices?.[0] ?? "x");
			}
			expect(build(command.name, argv).cmd).toBe(command.name);
		}
		delete process.env.ADE_SURFACE_ID;
	});

	it("dispatches hooks subcommands to their own wire commands", () => {
		expect(build("hooks", ["setup"]).cmd).toBe("hooks-setup");
		expect(build("hooks", ["setup", "claude"]).args).toEqual({
			agent: "claude",
		});
		expect(build("hooks", ["status"]).cmd).toBe("hooks-status");
		expect(() => build("hooks", ["frobnicate"])).toThrow();
	});
});

describe("new-pane", () => {
	it("defaults type to terminal and target to focused", () => {
		expect(build("new-pane", ["--direction", "right"])).toEqual({
			cmd: "new-pane",
			args: { pane: "focused", direction: "right", type: "terminal" },
		});
	});

	it("passes browser options through", () => {
		expect(
			build("new-pane", [
				"pane:2",
				"--type",
				"browser",
				"--direction",
				"left",
				"--url",
				"https://example.com",
				"--focus",
				"false",
			]),
		).toEqual({
			cmd: "new-pane",
			args: {
				pane: "pane:2",
				direction: "left",
				type: "browser",
				url: "https://example.com",
				focus: false,
			},
		});
	});

	it("treats --focus true as focus:true", () => {
		const request = build("new-pane", ["--direction", "up", "--focus", "true"]);
		expect(request.args.focus).toBe(true);
	});

	it("requires --direction", () => {
		expect(usageCode("new-pane", ["--type", "terminal"])).toBe(EXIT.USAGE);
	});

	it("rejects an unknown --type", () => {
		expect(
			usageCode("new-pane", ["--direction", "up", "--type", "hologram"]),
		).toBe(EXIT.USAGE);
	});

	it("rejects an unknown --direction", () => {
		expect(usageCode("new-pane", ["--direction", "sideways"])).toBe(EXIT.USAGE);
	});

	it("rejects a non-boolean --focus", () => {
		expect(
			usageCode("new-pane", ["--direction", "up", "--focus", "maybe"]),
		).toBe(EXIT.USAGE);
	});

	it("rejects an unknown flag", () => {
		expect(usageCode("new-pane", ["--direction", "up", "--nope"])).toBe(
			EXIT.USAGE,
		);
	});
});

describe("pane targeting", () => {
	it("defaults close-pane to the focused pane", () => {
		expect(build("close-pane", [])).toEqual({
			cmd: "close-pane",
			args: { pane: "focused" },
		});
	});

	it("accepts a UUID target verbatim", () => {
		const uuid = "6f1b0f5a-6a1e-4c2f-8b1d-8f0a2b3c4d5e";
		expect(build("close-pane", [uuid]).args.pane).toBe(uuid);
	});

	it("requires a target for focus-pane", () => {
		expect(usageCode("focus-pane", [])).toBe(EXIT.USAGE);
	});

	it("requires --to-tab for move-pane", () => {
		expect(usageCode("move-pane", ["pane:1"])).toBe(EXIT.USAGE);
	});

	it("sends move-pane's destination as to-tab", () => {
		expect(build("move-pane", ["pane:1", "--to-tab", "tab:2"])).toEqual({
			cmd: "move-pane",
			args: { pane: "pane:1", "to-tab": "tab:2" },
		});
	});

	it("rejects a stray extra positional", () => {
		expect(usageCode("close-pane", ["pane:1", "pane:2"])).toBe(EXIT.USAGE);
	});
});

describe("workspaces and tabs", () => {
	it("sends list-workspaces with no args", () => {
		expect(build("list-workspaces", [])).toEqual({
			cmd: "list-workspaces",
			args: {},
		});
	});

	it("requires --project for new-workspace", () => {
		expect(usageCode("new-workspace", [])).toBe(EXIT.USAGE);
	});

	it("passes --worktree as a boolean flag", () => {
		expect(build("new-workspace", ["--project", "ade", "--worktree"])).toEqual({
			cmd: "new-workspace",
			args: { project: "ade", worktree: true },
		});
	});

	it("filters list-tabs by workspace", () => {
		expect(build("list-tabs", ["--workspace", "workspace:1"]).args).toEqual({
			workspace: "workspace:1",
		});
	});
});

describe("terminal I/O", () => {
	it("joins the remaining argv into send's text", () => {
		expect(build("send", ["pane:1", "echo", "hello", "world"])).toEqual({
			cmd: "send",
			args: { pane: "pane:1", text: "echo hello world" },
		});
	});

	it("asks the server to append Enter rather than doing it itself", () => {
		// The server owns the append (optionalBoolean(args, "enter")), so the
		// text stays literal on the wire and there is only one place that can
		// double up the carriage return.
		expect(build("send", ["pane:1", "ls", "--enter"]).args).toEqual({
			pane: "pane:1",
			text: "ls",
			enter: true,
		});
		expect(build("send", ["pane:1", "ls"]).args).toEqual({
			pane: "pane:1",
			text: "ls",
		});
	});

	it("takes dash-leading text after --", () => {
		expect(build("send", ["pane:1", "--", "--help"]).args.text).toBe("--help");
	});

	it("requires both a pane and text", () => {
		expect(usageCode("send", ["pane:1"])).toBe(EXIT.USAGE);
		expect(usageCode("send", [])).toBe(EXIT.USAGE);
	});

	it("encodes send-key on the client side", () => {
		expect(build("send-key", ["pane:1", "C-c"])).toEqual({
			cmd: "send-key",
			args: { pane: "pane:1", key: "C-c", data: String.fromCharCode(3) },
		});
	});

	it("rejects an unknown key name with a usage error", () => {
		expect(usageCode("send-key", ["pane:1", "Frobnicate"])).toBe(EXIT.USAGE);
	});

	it("coerces --lines to a number", () => {
		expect(build("read-screen", ["pane:1", "--lines", "40"]).args.lines).toBe(
			40,
		);
	});

	it("rejects a non-numeric --lines", () => {
		expect(usageCode("read-screen", ["pane:1", "--lines", "many"])).toBe(
			EXIT.USAGE,
		);
	});

	it("omits lines when not given", () => {
		expect(build("read-screen", ["pane:1"]).args).toEqual({ pane: "pane:1" });
	});
});

describe("events", () => {
	it("subscribes to everything by default", () => {
		expect(build("events", [])).toEqual({
			cmd: "subscribe",
			args: { kinds: ["*"] },
		});
	});

	it("splits --kinds on commas", () => {
		expect(
			build("events", ["--kinds", "pane-created, notification"]).args,
		).toEqual({ kinds: ["pane-created", "notification"] });
	});
});
