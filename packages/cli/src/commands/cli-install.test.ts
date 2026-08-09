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

	/** Records every exec; answers with the given action (or a raw stdout/status). */
	function mockExec(opts: {
		action?: "present" | "added";
		status?: number;
		stdout?: string;
	}): { exec: WinPathExec; calls: { script: string; env: NodeJS.ProcessEnv }[] } {
		const calls: { script: string; env: NodeJS.ProcessEnv }[] = [];
		const exec: WinPathExec = (script, env) => {
			calls.push({ script, env });
			if (opts.status && opts.status !== 0) {
				return { status: opts.status, stdout: "", stderr: "powershell boom" };
			}
			const stdout =
				opts.stdout ?? JSON.stringify({ action: opts.action ?? "added" });
			return { status: 0, stdout, stderr: "" };
		};
		return { exec, calls };
	}

	it("refuses when the app has never written the launcher", async () => {
		await withHome(false, async (home) => {
			const cap = capture();
			const { exec, calls } = mockExec({});
			expect(await runWinInstall(cap.io, home, exec)).toBe(EXIT.USAGE);
			expect(cap.errText()).toContain("no launcher at");
			expect(cap.errText()).toContain("Start the ADE app once");
			expect(calls.length).toBe(0);
		});
	});

	it("adds the bin dir via ONE PowerShell invocation that reads and writes", async () => {
		await withHome(true, async (home) => {
			const bin = winBinDir(home);
			const cap = capture();
			const { exec, calls } = mockExec({ action: "added" });
			expect(await runWinInstall(cap.io, home, exec)).toBe(EXIT.OK);
			expect(cap.outText()).toContain("Installed:");
			expect(cap.outText()).toContain("Restart your shell");
			// F2: read-modify-write is a SINGLE process — no read-then-write race.
			expect(calls.length).toBe(1);
			const { script, env } = calls[0] as (typeof calls)[number];
			expect(env.ADE_BIN_DIR).toBe(bin);
			// F1: the script forces UTF-8 output so a non-ASCII PATH entry is not
			// mangled by the console's OEM code page on the way back to us.
			expect(script).toContain(
				"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
			);
			// Still reads unexpanded (%VAR% preserved) and writes in the same script.
			expect(script).toContain("DoNotExpandEnvironmentNames");
			expect(script).toContain("SetValue");
			// And the kind is carried through (REG_SZ vs REG_EXPAND_SZ preserved).
			expect(script).toContain("GetValueKind");
		});
	});

	it("reports idempotency when the script says the dir is already present", async () => {
		await withHome(true, async (home) => {
			const bin = winBinDir(home);
			const cap = capture();
			const { exec, calls } = mockExec({ action: "present" });
			expect(await runWinInstall(cap.io, home, exec)).toBe(EXIT.OK);
			expect(cap.outText()).toContain("Already on PATH");
			expect(cap.outText()).toContain(bin);
			expect(calls.length).toBe(1);
		});
	});

	it("fails cleanly when PowerShell exits nonzero", async () => {
		await withHome(true, async (home) => {
			const cap = capture();
			const { exec } = mockExec({ status: 1 });
			expect(await runWinInstall(cap.io, home, exec)).toBe(EXIT.USAGE);
			expect(cap.errText()).toContain("could not update your user PATH");
		});
	});

	it("fails cleanly when the script's result cannot be parsed", async () => {
		await withHome(true, async (home) => {
			const cap = capture();
			const { exec } = mockExec({ stdout: "not json" });
			expect(await runWinInstall(cap.io, home, exec)).toBe(EXIT.USAGE);
			expect(cap.errText()).toContain("could not parse the result");
		});
	});
});
