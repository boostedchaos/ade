import { describe, expect, it, mock } from "bun:test";
import {
	buildTerminalCommand,
	launchCommandInPane,
	writeCommandsInPane,
} from "./launch-command";

describe("launchCommandInPane", () => {
	it("creates a terminal session and writes the command with a carriage return", async () => {
		const createOrAttach = mock(async () => ({}));
		const write = mock(async () => ({}));

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "echo hello",
			createOrAttach,
			write,
		});

		expect(createOrAttach).toHaveBeenCalledWith({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
		});
		// \r (Enter), not \n — otherwise the command stages but never runs.
		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: "echo hello\r",
			throwOnError: true,
		});
	});

	it("settles before writing when a fresh shell was spawned (issue #49)", async () => {
		const createOrAttach = mock(async () => ({ isNew: true }));
		const write = mock(
			async (_input: { paneId: string; data: string; throwOnError?: boolean }) =>
				({}),
		);
		const order: string[] = [];
		const delay = mock(async (_ms: number) => {
			order.push("delay");
		});
		const wrappedWrite = mock(async (input: { paneId: string; data: string }) => {
			order.push("write");
			return write(input);
		});

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "claude --resume abc",
			createOrAttach,
			write: wrappedWrite,
			settleMs: 300,
			delay,
		});

		// The command still runs — just after the shell has had a beat to settle.
		expect(delay).toHaveBeenCalledWith(300);
		expect(order).toEqual(["delay", "write"]);
		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: "claude --resume abc\r",
			throwOnError: true,
		});
	});

	it("writes immediately when warm-attaching to a live shell", async () => {
		const createOrAttach = mock(async () => ({ isNew: false }));
		const write = mock(async () => ({}));
		const delay = mock(async (_ms: number) => {});

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "echo hi",
			createOrAttach,
			write,
			delay,
		});

		expect(delay).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: "echo hi\r",
			throwOnError: true,
		});
	});

	it("normalizes a trailing newline to a carriage return", async () => {
		const createOrAttach = mock(async () => ({}));
		const write = mock(async () => ({}));

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "echo hello\n",
			createOrAttach,
			write,
		});

		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: "echo hello\r",
			throwOnError: true,
		});
	});

	it("leaves a command that already ends in a carriage return unchanged", async () => {
		const createOrAttach = mock(async () => ({}));
		const write = mock(async () => ({}));

		await launchCommandInPane({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			command: "echo hello\r",
			createOrAttach,
			write,
		});

		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: "echo hello\r",
			throwOnError: true,
		});
	});
});

describe("buildTerminalCommand", () => {
	it("joins with && on POSIX", () => {
		expect(buildTerminalCommand(["echo one", "echo two"], false)).toBe(
			"echo one && echo two",
		);
	});

	it("joins with a PowerShell 5.1-safe fail-fast chain on Windows", () => {
		expect(buildTerminalCommand(["echo one", "echo two"], true)).toBe(
			'echo one; if (-not $?) { throw "command failed" }; echo two',
		);
	});

	it("emits a single command unchanged on both platforms", () => {
		expect(buildTerminalCommand(["echo one"], false)).toBe("echo one");
		expect(buildTerminalCommand(["echo one"], true)).toBe("echo one");
	});

	it("returns null for empty commands", () => {
		expect(buildTerminalCommand([])).toBeNull();
		expect(buildTerminalCommand(null)).toBeNull();
		expect(buildTerminalCommand(undefined)).toBeNull();
	});
});

describe("writeCommandsInPane", () => {
	it("writes joined command with a carriage return", async () => {
		const write = mock(async () => ({}));

		await writeCommandsInPane({
			paneId: "pane-1",
			commands: ["echo one", "echo two"],
			write,
		});

		// Join text is platform-dependent (host default); assert consistency
		// with buildTerminalCommand rather than duplicating the separator.
		expect(write).toHaveBeenCalledWith({
			paneId: "pane-1",
			data: `${buildTerminalCommand(["echo one", "echo two"])}\r`,
			throwOnError: true,
		});
	});

	it("does not write when commands are empty", async () => {
		const write = mock(async () => ({}));

		await writeCommandsInPane({
			paneId: "pane-1",
			commands: [],
			write,
		});

		expect(write).not.toHaveBeenCalled();
	});
});
