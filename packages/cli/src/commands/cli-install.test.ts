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
import { resolveInstallDir, runCli, SYSTEM_BIN_DIR } from "./cli-install";

const IS_WIN = process.platform === "win32";

/**
 * The directory CHOICE is pure and covered exhaustively here. The filesystem
 * half is driven through the `home` seam and `--dir` into a temp directory —
 * nothing in this file touches /usr/local/bin or the developer's real ~/.ade,
 * because a test that did would be measuring the machine, not the code.
 */
describe("resolveInstallDir", () => {
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
