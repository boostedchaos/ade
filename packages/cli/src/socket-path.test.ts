import { describe, expect, it } from "bun:test";
import {
	getAdeDirName,
	getControlSocketPathFor,
	getControlTokenPathFor,
	getWorkspaceSuffix,
	isNamedPipePath,
} from "./socket-path";

const skipWin = process.platform === "win32";

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

describe("ADE_DATA_DIR_NAME precedence", () => {
	// THE BUG this precedence exists for: inside a workspace named "Ethel" the
	// app injects SUPERSET_WORKSPACE_NAME=Ethel (a DISPLAY name), and the old
	// derivation turned that into ~/.ade-ethel — so every agent terminal's
	// `ade` reported the running app as not running.
	it("wins over a conflicting SUPERSET_WORKSPACE_NAME", () => {
		expect(
			getAdeDirName({
				SUPERSET_WORKSPACE_NAME: "Ethel",
				ADE_DATA_DIR_NAME: ".ade-default",
			}),
		).toBe(".ade-default");
	});

	it("is used verbatim, without re-deriving a suffix", () => {
		expect(getAdeDirName({ ADE_DATA_DIR_NAME: ".ade" })).toBe(".ade");
		expect(getAdeDirName({ ADE_DATA_DIR_NAME: ".ade-My_Dir.2" })).toBe(
			".ade-My_Dir.2",
		);
	});

	it("falls through to the workspace derivation when unset or empty", () => {
		expect(getAdeDirName({ SUPERSET_WORKSPACE_NAME: "probe" })).toBe(
			".ade-probe",
		);
		expect(
			getAdeDirName({
				SUPERSET_WORKSPACE_NAME: "probe",
				ADE_DATA_DIR_NAME: "",
			}),
		).toBe(".ade-probe");
	});

	it("falls through to .ade when nothing is set", () => {
		expect(getAdeDirName({})).toBe(".ade");
	});

	it.each([
		["a separator", ".ade/../../etc"],
		["a backslash", ".ade\\evil"],
		["traversal", ".."],
		["no leading dot", "ade-default"],
		["an absolute path", "/etc"],
		["a space", ".ade dir"],
		["a tilde", ".ade~"],
	])("rejects %s and falls through", (_label, value) => {
		// The value becomes a path segment directly under the home dir, so an
		// invalid one must be discarded, never sanitised into something else.
		expect(
			getAdeDirName({
				SUPERSET_WORKSPACE_NAME: "probe",
				ADE_DATA_DIR_NAME: value,
			}),
		).toBe(".ade-probe");
	});

	it("reads process.env when called with no argument", () => {
		const previous = process.env.ADE_DATA_DIR_NAME;
		const previousWs = process.env.SUPERSET_WORKSPACE_NAME;
		try {
			process.env.SUPERSET_WORKSPACE_NAME = "Ethel";
			process.env.ADE_DATA_DIR_NAME = ".ade-default";
			expect(getAdeDirName()).toBe(".ade-default");
		} finally {
			if (previous === undefined) delete process.env.ADE_DATA_DIR_NAME;
			else process.env.ADE_DATA_DIR_NAME = previous;
			if (previousWs === undefined) delete process.env.SUPERSET_WORKSPACE_NAME;
			else process.env.SUPERSET_WORKSPACE_NAME = previousWs;
		}
	});

	it("ignores the env var when an explicit workspace name is passed", () => {
		const previous = process.env.ADE_DATA_DIR_NAME;
		try {
			process.env.ADE_DATA_DIR_NAME = ".ade-default";
			expect(getAdeDirName("probe")).toBe(".ade-probe");
		} finally {
			if (previous === undefined) delete process.env.ADE_DATA_DIR_NAME;
			else process.env.ADE_DATA_DIR_NAME = previous;
		}
	});
});

describe("control endpoint paths", () => {
	// getControlTokenPathFor uses the host's path.join, so the POSIX literal
	// only holds on POSIX; the win32 socket case below is the Windows contract.
	it.skipIf(skipWin)("builds a unix socket path under the data dir", () => {
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
