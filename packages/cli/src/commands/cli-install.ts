/**
 * `ade cli install` — put `ade` on the PATH of a terminal ADE did not launch.
 *
 * WHY IT IS NEEDED. `~/.ade[-ws]/bin` already holds a working `ade` launcher
 * (server-core's agent-setup writes it on every app boot), and that directory
 * is already prepended to PATH — but only by the rc files ADE injects via
 * ZDOTDIR into its OWN PTYs. A plain Terminal.app or iTerm window has never
 * seen them, so `ade` is not found there. SPEC ship-gate 3 is a human running
 * `ade list-workspaces` from exactly such a terminal.
 *
 * WHAT IT DOES. Symlinks the existing launcher into a directory that is on the
 * normal PATH. It does not copy the script: the launcher bakes in the resolved
 * CLI entry path and is rewritten whenever that changes, so a symlink stays
 * correct across app updates where a copy would silently rot.
 *
 * The directory resolution is pure (`resolveInstallDir`) and tested; the
 * filesystem half is not, because a test that actually writes to /usr/local/bin
 * would be testing the machine rather than the code.
 */
import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { Command, LocalIo } from "../command";
import { EXIT } from "../errors";
import { getAdeDirName } from "../socket-path";

/** Where agent-setup writes the launcher this command links to. */
export function adeLauncherPath(home = homedir()): string {
	return join(home, getAdeDirName(), "bin", "ade");
}

/** Tried first: the conventional system location, when it is writable. */
export const SYSTEM_BIN_DIR = "/usr/local/bin";

export interface InstallDirChoice {
	dir: string;
	/** False means the user has to add `dir` to PATH themselves. */
	onPath: boolean;
	/** True when this is the fallback, i.e. the system dir was not writable. */
	isFallback: boolean;
}

/**
 * Pure. `--dir` wins outright (including a non-writable one — the caller finds
 * out when the write fails, which is a better error than "I picked somewhere
 * else"). Otherwise the system dir if writable, else ~/.local/bin, which is on
 * PATH by default on most modern distros and on none of macOS's defaults —
 * hence the hint.
 */
export function resolveInstallDir(params: {
	override?: string;
	home?: string;
	pathEntries: string[];
	isWritableDir: (dir: string) => boolean;
}): InstallDirChoice {
	const home = params.home ?? homedir();
	const onPath = (dir: string) =>
		params.pathEntries.some((entry) => entry !== "" && resolve(entry) === dir);

	if (params.override) {
		const dir = resolve(params.override);
		return { dir, onPath: onPath(dir), isFallback: false };
	}
	if (params.isWritableDir(SYSTEM_BIN_DIR)) {
		return {
			dir: SYSTEM_BIN_DIR,
			onPath: onPath(SYSTEM_BIN_DIR),
			isFallback: false,
		};
	}
	const fallback = join(home, ".local", "bin");
	return { dir: fallback, onPath: onPath(fallback), isFallback: true };
}

function isWritableDir(dir: string): boolean {
	try {
		accessSync(dir, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/** Where an existing `ade` at `target` points, or null if it is not a symlink. */
function existingLinkTarget(target: string): string | null {
	try {
		if (!lstatSync(target).isSymbolicLink()) return null;
		return resolve(readlinkSync(target));
	} catch {
		return null;
	}
}

function parseInstallArgs(
	argv: string[],
): { dir?: string } | { error: string } {
	let dir: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--dir") {
			const value = argv[i + 1];
			if (!value) return { error: "--dir needs a directory" };
			dir = value;
			i += 1;
		} else if (arg?.startsWith("--dir=")) {
			dir = arg.slice("--dir=".length);
			if (!dir) return { error: "--dir needs a directory" };
		} else {
			return { error: `unknown option: ${arg}` };
		}
	}
	return { dir };
}

/**
 * `home` is a seam so tests can drive the real filesystem logic against a temp
 * directory instead of the developer's actual ~/.ade and /usr/local/bin.
 */
export async function runCli(
	argv: string[],
	io: LocalIo,
	home = homedir(),
): Promise<number> {
	const [sub, ...rest] = argv;

	if (sub === undefined || sub === "--help" || sub === "-h") {
		io.stdout("Usage: ade cli install [--dir <dir>]");
		io.stdout("");
		io.stdout("  install   Symlink the ade launcher into a directory on PATH,");
		io.stdout("            so `ade` works in terminals ADE did not launch.");
		return sub === undefined ? EXIT.USAGE : EXIT.OK;
	}
	if (sub !== "install") {
		io.stderr(`ade cli: unknown subcommand "${sub}"`);
		return EXIT.USAGE;
	}

	if (process.platform === "win32") {
		// Not a stub-by-neglect: a Windows install means a .cmd shim plus a
		// PATH edit in the user environment block, which is a different piece
		// of work from a symlink. Saying so beats pretending to succeed.
		io.stderr("ade cli install: not supported on Windows yet.");
		io.stderr(
			`Add this directory to your PATH manually: ${join(home, getAdeDirName(), "bin")}`,
		);
		return EXIT.USAGE;
	}

	const parsed = parseInstallArgs(rest);
	if ("error" in parsed) {
		io.stderr(`ade cli install: ${parsed.error}`);
		return EXIT.USAGE;
	}

	const source = adeLauncherPath(home);
	if (!existsSync(source)) {
		io.stderr(`ade cli install: no launcher at ${source}`);
		io.stderr("Start the ADE app once — it writes the launcher on boot.");
		return EXIT.USAGE;
	}

	const choice = resolveInstallDir({
		override: parsed.dir,
		home,
		pathEntries: (process.env.PATH ?? "").split(delimiter),
		isWritableDir,
	});

	try {
		mkdirSync(choice.dir, { recursive: true });
	} catch (error) {
		io.stderr(
			`ade cli install: cannot create ${choice.dir}: ${error instanceof Error ? error.message : error}`,
		);
		return EXIT.USAGE;
	}

	const target = join(choice.dir, "ade");
	const linked = existingLinkTarget(target);
	if (linked === source) {
		io.stdout(`Already installed: ${target} -> ${source}`);
	} else {
		if (existsSync(target) || linked !== null) {
			if (linked === null) {
				io.stderr(
					`ade cli install: ${target} exists and is not a symlink; refusing to replace it.`,
				);
				io.stderr("Re-run with --dir <somewhere-else>, or remove it yourself.");
				return EXIT.USAGE;
			}
			// Repointing our own stale symlink is safe and is what makes this
			// idempotent across app updates that move the launcher.
			try {
				unlinkSync(target);
			} catch {
				// symlinkSync will report the real problem
			}
		}
		try {
			symlinkSync(source, target);
		} catch (error) {
			io.stderr(
				`ade cli install: cannot link ${target}: ${error instanceof Error ? error.message : error}`,
			);
			return EXIT.USAGE;
		}
		io.stdout(`Installed: ${target} -> ${source}`);
	}

	if (!choice.onPath) {
		io.stdout("");
		io.stdout(`${choice.dir} is not on your PATH. Add it:`);
		io.stdout(`  export PATH="${choice.dir}:$PATH"`);
	}
	return EXIT.OK;
}

export const cliBinCommands: Command[] = [
	{
		name: "cli",
		group: "Parity extras",
		summary: "Manage the ade bin itself (cli install — put `ade` on PATH)",
		kind: "local",
		rawArgs: true,
		notes:
			"`ade cli install` symlinks ~/.ade[-ws]/bin/ade into a PATH directory\n" +
			"(/usr/local/bin when writable, otherwise ~/.local/bin). Use --dir to\n" +
			"choose one yourself. Safe to re-run. Windows is not supported yet.",
		runLocal: runCli,
	},
];
