import { describe, expect, it } from "bun:test";
import {
	getAdeDirName,
	getControlSocketPathFor,
	getControlTokenPathFor,
	getWorkspaceSuffix,
	isNamedPipePath,
} from "./socket-path";

describe("data-dir derivation", () => {
	it("uses .ade for the default workspace name", () => {
		expect(getWorkspaceSuffix("superset")).toBeUndefined();
		expect(getAdeDirName("superset")).toBe(".ade");
	});

	it("reads SUPERSET_WORKSPACE_NAME when no name is passed", () => {
		const previous = process.env.SUPERSET_WORKSPACE_NAME;
		try {
			process.env.SUPERSET_WORKSPACE_NAME = "probe";
			expect(getAdeDirName()).toBe(".ade-probe");
			delete process.env.SUPERSET_WORKSPACE_NAME;
			expect(getAdeDirName()).toBe(".ade");
		} finally {
			if (previous === undefined) delete process.env.SUPERSET_WORKSPACE_NAME;
			else process.env.SUPERSET_WORKSPACE_NAME = previous;
		}
	});

	it("suffixes and sanitises any other workspace name", () => {
		expect(getAdeDirName("Default")).toBe(".ade-default");
		expect(getAdeDirName("my WS!")).toBe(".ade-my-ws-");
	});

	it("truncates a long workspace name to 32 chars", () => {
		expect(getAdeDirName("a".repeat(50))).toBe(`.ade-${"a".repeat(32)}`);
	});
});

describe("control endpoint paths", () => {
	it("builds a unix socket path under the data dir", () => {
		expect(getControlSocketPathFor(".ade", "/home/k", "darwin")).toBe(
			"/home/k/.ade/control.sock",
		);
		expect(getControlTokenPathFor(".ade", "/home/k")).toBe(
			"/home/k/.ade/control.token",
		);
	});

	it("builds a named pipe on win32, stripping the leading dot", () => {
		const path = getControlSocketPathFor(
			".ade-default",
			"C:\\Users\\k",
			"win32",
		);
		expect(path.startsWith("\\\\.\\pipe\\ade-default-control-")).toBe(true);
		expect(isNamedPipePath(path)).toBe(true);
	});

	it("does not treat a unix path as a named pipe", () => {
		expect(isNamedPipePath("/home/k/.ade/control.sock")).toBe(false);
	});
});
