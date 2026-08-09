import { describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../errors";
import { getAdeDirName } from "../socket-path";
import type { WinPathExec } from "./cli-install";
import {
	appendPathEntry,
	resolveInstallDir,
	runCli,
	runWinInstall,
	SYSTEM_BIN_DIR,
	userPathHasDir,
	winBinDir,
} from "./cli-install";

const IS_WIN = process.platform === "win32";

/**
 * The directory CHOICE is pure and covered exhaustively here. The filesystem
 * half is driven through the `home` seam and `--dir` into a temp directory —
 * nothing in this file touches /usr/local/bin or the developer's real ~/.ade,
 * because a test that did would be measuring the machine, not the code.
 */
// POSIX-only: resolveInstallDir reasons about /usr/local/bin and resolves
// paths, which reshapes them on Windows. The Windows install takes a wholly
// different path (runWinInstall), covered below.
describe.skipIf(IS_WIN)("resolveInstallDir", () => {
	const never = () => false;
	const always = () => true;

	it("prefers the system bin dir when it is writable", () => {
		expect(
			resolveInstallDir({
				home: "/home/k",
				pathEntries: ["/usr/local/bin", "/usr/bin"],
				isWritableDir: always,
			}),
		).toEqual({ dir: SYSTEM_BIN_DIR, onPath: true, isFallback: false });
	});

	it("falls back to ~/.local/bin when it is not", () => {
		expect(
			resolveInstallDir({
				home: "/home/k",
				pathEntries: ["/usr/bin"],
				isWritableDir: never,
			}),
		).toEqual({ dir: "/home/k/.local/bin", onPath: false, isFallback: true });
	});

	it("notices when the fallback is already on PATH", () => {
		expect(
			resolveInstallDir({
				home: "/home/k",
				pathEntries: ["/usr/bin", "/home/k/.local/bin"],
				isWritableDir: never,
			}).onPath,
		).toBe(true);
	});

	it("--dir wins outright, even over a writable system dir", () => {
		expect(
			resolveInstallDir({
				override: "/opt/tools/bin",
				home: "/home/k",
				pathEntries: ["/usr/local/bin"],
				isWritableDir: always,
			}),
		).toEqual({ dir: "/opt/tools/bin", onPath: false, isFallback: false });
	});

	it("compares PATH entries by resolved path, not by string", () => {
		expect(
			resolveInstallDir({
				override: "/opt/tools/bin",
				home: "/home/k",
				// A trailing slash and an empty entry are both normal in a real PATH.
				pathEntries: ["", "/opt/tools/bin/", "/usr/bin"],
				isWritableDir: never,
			}).onPath,
		).toBe(true);
	});
});

describe("ade cli argument handling", () => {
	function capture() {
		const out: string[] = [];
		const err: string[] = [];
		return {
			io: {
				stdout: (l: string) => out.push(l),
				stderr: (l: string) => err.push(l),
			},
			outText: () => out.join("\n"),
			errText: () => err.join("\n"),
		};
	}

	it("prints usage and exits 2 with no subcommand", async () => {
		const cap = capture();
		expect(await runCli([], cap.io)).toBe(EXIT.USAGE);
		expect(cap.outText()).toContain("ade cli install");
	});

	it("exits 0 for --help", async () => {
		const cap = capture();
		expect(await runCli(["--help"], cap.io)).toBe(EXIT.OK);
	});

	it("rejects an unknown subcommand", async () => {
		const cap = capture();
		expect(await runCli(["frobnicate"], cap.io)).toBe(EXIT.USAGE);
		expect(cap.errText()).toContain("unknown subcommand");
	});

	it("rejects --dir with no value and unknown options", async () => {
		const noValue = capture();
		expect(await runCli(["install", "--dir"], noValue.io)).toBe(EXIT.USAGE);
		expect(noValue.errText()).toContain("--dir needs a directory");

		const unknown = capture();
		expect(await runCli(["install", "--wat"], unknown.io)).toBe(EXIT.USAGE);
		expect(unknown.errText()).toContain("unknown option");
	});
});

describe.skipIf(IS_WIN)("ade cli install, against a temp home", () => {
	function capture() {
		const out: string[] = [];
		const err: string[] = [];
		return {
			io: {
				stdout: (l: string) => out.push(l),
				stderr: (l: string) => err.push(l),
			},
			outText: () => out.join("\n"),
			errText: () => err.join("\n"),
		};
	}

	async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
		const home = mkdtempSync(join(tmpdir(), "ade-cli-install-"));
		try {
			await fn(home);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}

	/** Stands in for the launcher agent-setup writes on app boot. */
	function seedLauncher(home: string): string {
		const dir = join(home, getAdeDirName(), "bin");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "ade");
		writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
		return path;
	}

	it("says what to do when the app has never run", async () => {
		await withHome(async (home) => {
			const cap = capture();
			const dir = join(home, "bin");
			expect(await runCli(["install", "--dir", dir], cap.io, home)).toBe(
				EXIT.USAGE,
			);
			expect(cap.errText()).toContain("no launcher at");
			expect(cap.errText()).toContain("Start the ADE app once");
		});
	});

	it("links the launcher and is idempotent", async () => {
		await withHome(async (home) => {
			const source = seedLauncher(home);
			const dir = join(home, "bin");

			const first = capture();
			expect(await runCli(["install", "--dir", dir], first.io, home)).toBe(
				EXIT.OK,
			);
			expect(first.outText()).toContain("Installed:");
			expect(readlinkSync(join(dir, "ade"))).toBe(source);

			const second = capture();
			expect(await runCli(["install", "--dir", dir], second.io, home)).toBe(
				EXIT.OK,
			);
			expect(second.outText()).toContain("Already installed:");
			expect(readlinkSync(join(dir, "ade"))).toBe(source);
		});
	});

	it("repoints its own stale symlink but refuses to clobber a real file", async () => {
		await withHome(async (home) => {
			const source = seedLauncher(home);
			const dir = join(home, "bin");
			mkdirSync(dir, { recursive: true });

			// A stale link from an older install location is ours to fix.
			symlinkSync(join(home, "old-ade"), join(dir, "ade"));
			const relink = capture();
			expect(await runCli(["install", "--dir", dir], relink.io, home)).toBe(
				EXIT.OK,
			);
			expect(readlinkSync(join(dir, "ade"))).toBe(source);

			// Someone else's real `ade` binary is not.
			rmSync(join(dir, "ade"));
			writeFileSync(join(dir, "ade"), "someone else's ade\n");
			const refuse = capture();
			expect(await runCli(["install", "--dir", dir], refuse.io, home)).toBe(
				EXIT.USAGE,
			);
			expect(refuse.errText()).toContain("not a symlink");
		});
	});

	it("prints a PATH hint when the chosen dir is not on PATH", async () => {
		await withHome(async (home) => {
			seedLauncher(home);
			const dir = join(home, "definitely-not-on-path");
			const cap = capture();
			expect(await runCli(["install", "--dir", dir], cap.io, home)).toBe(
				EXIT.OK,
			);
			expect(cap.outText()).toContain("is not on your PATH");
			expect(cap.outText()).toContain(`export PATH="${dir}:$PATH"`);
		});
	});
});

// Windows PATH matching — pure, so it runs on every platform.
describe("userPathHasDir", () => {
	const dir = "C:\\Users\\k\\.ade\\bin";
	it("matches an exact entry", () => {
		expect(userPathHasDir(`C:\\other;${dir};C:\\more`, dir)).toBe(true);
	});
	it("ignores case (Windows paths are case-insensitive)", () => {
		expect(userPathHasDir("c:\\users\\K\\.ADE\\BIN", dir)).toBe(true);
	});
	it("tolerates a trailing slash or backslash", () => {
		expect(userPathHasDir(`${dir}\\`, dir)).toBe(true);
		expect(userPathHasDir(`${dir}/`, dir)).toBe(true);
	});
	it("skips empty entries and reports a genuine absence", () => {
		expect(userPathHasDir(";;C:\\other;", dir)).toBe(false);
		expect(userPathHasDir("", dir)).toBe(false);
	});
});

describe("appendPathEntry", () => {
	const dir = "C:\\Users\\k\\.ade\\bin";
	it("uses the dir alone when PATH was empty", () => {
		expect(appendPathEntry("", dir)).toBe(dir);
	});
	it("appends with a single separator", () => {
		expect(appendPathEntry("C:\\a", dir)).toBe(`C:\\a;${dir}`);
	});
	it("does not double a trailing separator", () => {
		expect(appendPathEntry("C:\\a;", dir)).toBe(`C:\\a;${dir}`);
	});
});

// runWinInstall drives a mocked PowerShell, so it runs and asserts on every
// platform — no real registry or shell involved.
describe("runWinInstall (mocked PowerShell)", () => {
	function capture() {
		const out: string[] = [];
		const err: string[] = [];
		return {
			io: {
				stdout: (l: string) => out.push(l),
				stderr: (l: string) => err.push(l),
			},
			outText: () => out.join("\n"),
			errText: () => err.join("\n"),
		};
	}

	async function withHome(
		seedCmd: boolean,
		fn: (home: string) => Promise<void>,
	): Promise<void> {
		const home = mkdtempSync(join(tmpdir(), "ade-win-install-"));
		try {
			if (seedCmd) {
				const bin = winBinDir(home);
				mkdirSync(bin, { recursive: true });
				writeFileSync(join(bin, "ade.cmd"), "@echo off\r\n");
			}
			await fn(home);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}

	/** Records every exec and answers the read with the given raw PATH + kind. */
	function mockExec(opts: {
		raw: string;
		kind: string;
		readStatus?: number;
		writeStatus?: number;
	}): { exec: WinPathExec; calls: { script: string; env: NodeJS.ProcessEnv }[] } {
		const calls: { script: string; env: NodeJS.ProcessEnv }[] = [];
		const exec: WinPathExec = (script, env) => {
			calls.push({ script, env });
			if (script.includes("SetValue")) {
				const status = opts.writeStatus ?? 0;
				return { status, stdout: "", stderr: status ? "write boom" : "" };
			}
			const status = opts.readStatus ?? 0;
			if (status !== 0) return { status, stdout: "", stderr: "read boom" };
			return {
				status: 0,
				stdout: JSON.stringify({ raw: opts.raw, kind: opts.kind }),
				stderr: "",
			};
		};
		return { exec, calls };
	}

	it("refuses when the app has never written the launcher", async () => {
		await withHome(false, async (home) => {
			const cap = capture();
			const { exec, calls } = mockExec({ raw: "", kind: "ExpandString" });
			expect(await runWinInstall(cap.io, home, exec)).toBe(EXIT.USAGE);
			expect(cap.errText()).toContain("no launcher at");
			expect(cap.errText()).toContain("Start the ADE app once");
			expect(calls.length).toBe(0);
		});
	});

	it("appends the bin dir, preserving kind and unexpanded %VARs%", async () => {
		await withHome(true, async (home) => {
			const bin = winBinDir(home);
			const cap = capture();
			const { exec, calls } = mockExec({
				raw: "C:\\Windows;%USERPROFILE%\\tools",
				kind: "ExpandString",
			});
			expect(await runWinInstall(cap.io, home, exec)).toBe(EXIT.OK);
			expect(cap.outText()).toContain("Installed:");
			expect(cap.outText()).toContain("Restart your shell");
			const write = calls.find((c) => c.script.includes("SetValue"));
			expect(write).toBeDefined();
			// %USERPROFILE% survives verbatim; the bin dir is appended once.
			expect(write?.env.ADE_NEW_PATH).toBe(
				`C:\\Windows;%USERPROFILE%\\tools;${bin}`,
			);
			expect(write?.env.ADE_PATH_KIND).toBe("ExpandString");
		});
	});

	it("preserves a REG_SZ value's kind (String)", async () => {
		await withHome(true, async (home) => {
			const cap = capture();
			const { exec, calls } = mockExec({ raw: "C:\\Windows", kind: "String" });
			await runWinInstall(cap.io, home, exec);
			const write = calls.find((c) => c.script.includes("SetValue"));
			expect(write?.env.ADE_PATH_KIND).toBe("String");
		});
	});

	it("is idempotent — already present means no write", async () => {
		await withHome(true, async (home) => {
			const bin = winBinDir(home);
			const cap = capture();
			// Same dir, uppercased and with a trailing backslash: still a match.
			const { exec, calls } = mockExec({
				raw: `C:\\Windows;${bin.toUpperCase()}\\`,
				kind: "ExpandString",
			});
			expect(await runWinInstall(cap.io, home, exec)).toBe(EXIT.OK);
			expect(cap.outText()).toContain("Already on PATH");
			expect(calls.some((c) => c.script.includes("SetValue"))).toBe(false);
		});
	});

	it("fails cleanly when the PATH read fails", async () => {
		await withHome(true, async (home) => {
			const cap = capture();
			const { exec } = mockExec({ raw: "", kind: "ExpandString", readStatus: 1 });
			expect(await runWinInstall(cap.io, home, exec)).toBe(EXIT.USAGE);
			expect(cap.errText()).toContain("could not read your user PATH");
		});
	});

	it("fails cleanly when the PATH write fails", async () => {
		await withHome(true, async (home) => {
			const cap = capture();
			const { exec } = mockExec({
				raw: "C:\\Windows",
				kind: "ExpandString",
				writeStatus: 1,
			});
			expect(await runWinInstall(cap.io, home, exec)).toBe(EXIT.USAGE);
			expect(cap.errText()).toContain("could not update your user PATH");
		});
	});
});
