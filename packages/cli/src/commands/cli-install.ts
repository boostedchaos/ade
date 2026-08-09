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
import { spawnSync } from "node:child_process";
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
	winExec: WinPathExec = defaultWinExec,
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
		// Windows has no symlink-into-PATH story: the app already writes
		// ade.cmd into the bin dir, so the install is purely a user-PATH edit.
		const parsed = parseInstallArgs(rest);
		if ("error" in parsed) {
			io.stderr(`ade cli install: ${parsed.error}`);
			return EXIT.USAGE;
		}
		if (parsed.dir) {
			io.stderr(
				"ade cli install: --dir is not used on Windows; the ade bin dir is added to your user PATH.",
			);
			return EXIT.USAGE;
		}
		return runWinInstall(io, home, winExec);
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

// ---------------------------------------------------------------------------
// Windows install: add ~/.ade[-ws]/bin to the USER PATH.
//
// There is nothing to symlink on Windows — the app writes ade.cmd into the bin
// dir on boot, and that dir is already prepended for the terminals ADE spawns.
// The install just makes it visible to shells ADE did not launch, by adding it
// to the user's persistent PATH (HKCU\Environment\Path).
//
// TWO footguns this code exists to avoid:
//   1. setx truncates PATH at 1024 chars. Never used. We write the registry
//      value directly, which has no such limit.
//   2. The user Path value is usually REG_EXPAND_SZ and holds unexpanded
//      %VAR% entries. A read-modify-write via .NET's high-level
//      GetEnvironmentVariable/SetEnvironmentVariable can expand those entries
//      and/or flip the value to REG_SZ, corrupting PATH. So we read with
//      DoNotExpandEnvironmentNames and write back with the ORIGINAL kind via
//      the Microsoft.Win32.Registry API, preserving both.
// ---------------------------------------------------------------------------

export interface WinExecResult {
	status: number;
	stdout: string;
	stderr: string;
}

/** Seam so tests drive the logic without a real registry or PowerShell. */
export type WinPathExec = (
	script: string,
	env: NodeJS.ProcessEnv,
) => WinExecResult;

/** Where the app writes ade.cmd, and what we add to PATH. */
export function winBinDir(home = homedir()): string {
	return join(home, getAdeDirName(), "bin");
}

/**
 * Is `dir` already a PATH entry? Case-insensitive (Windows paths are) and
 * tolerant of a trailing slash/backslash and empty entries.
 *
 * Reference spec, unit-tested here: WIN_INSTALL_PATH_PS reimplements this exact
 * rule in PowerShell (it must decide membership inside the single read-write
 * process). Keep the two in sync.
 *
 * ponytail: compares literal strings, so a manually-added `%USERPROFILE%\...`
 * entry pointing at the same place would not be detected and we would add a
 * second (expanded) copy. Acceptable — our own appended entry is always
 * literal, so re-running install stays idempotent.
 */
export function userPathHasDir(rawPath: string, dir: string): boolean {
	const norm = (s: string) => s.trim().replace(/[\\/]+$/, "").toLowerCase();
	const target = norm(dir);
	if (target === "") return false;
	return rawPath
		.split(";")
		.some((entry) => entry.trim() !== "" && norm(entry) === target);
}

/** Append `dir` to a raw PATH value, collapsing a stray trailing separator. */
export function appendPathEntry(rawPath: string, dir: string): string {
	if (rawPath === "") return dir;
	return rawPath.endsWith(";") ? `${rawPath}${dir}` : `${rawPath};${dir}`;
}

/** What the single install script reports it did. */
export function parseInstallResult(stdout: string): "present" | "added" | null {
	try {
		const obj = JSON.parse(stdout.trim() || "{}") as { action?: unknown };
		return obj.action === "present" || obj.action === "added"
			? obj.action
			: null;
	} catch {
		return null;
	}
}

/**
 * Read HKCU\Environment\Path and, if $env:ADE_BIN_DIR is not already an entry,
 * append it and write it back — ALL IN ONE PowerShell process.
 *
 * WHY ONE PROCESS (F2). A two-invocation read-then-write races a concurrent PATH
 * editor: anything it wrote between our read and our write gets clobbered when we
 * write back our stale-plus-appended value. Doing read→check→append→write in a
 * single process shrinks that window to microseconds. The residual race against
 * another editor writing DURING our own read-modify-write is inherent to Windows
 * user-PATH editing — setx and the Settings dialog have the exact same window; we
 * just must not enlarge it.
 *
 * WHY THE ENCODING LINE (F1). spawnSync decodes this script's stdout as utf8, but
 * a console's default OutputEncoding is the OEM code page (e.g. CP437), which
 * would mangle a non-ASCII PATH entry (C:\工具) on the way out and we would write
 * the corruption back. Force UTF-8 output before we emit anything.
 *
 * %VAR% entries are preserved: read with DoNotExpandEnvironmentNames, written
 * back with the original kind (anything not REG_SZ → REG_EXPAND_SZ, PATH's
 * default and the only kind that keeps %VAR% live). The membership + append rules
 * mirror userPathHasDir / appendPathEntry (kept below as the unit-tested spec —
 * keep the two in sync); this path is exercised end-to-end by the live
 * round-trip. Emits {action:'present'|'added'} JSON.
 */
const WIN_INSTALL_PATH_PS = [
	"$ErrorActionPreference='Stop'",
	"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
	"$dir=$env:ADE_BIN_DIR",
	"$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)",
	"if(-not $key){ $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }",
	"$raw=''",
	"$kind='ExpandString'",
	"if(($key.GetValueNames()) -contains 'Path'){",
	"  $raw=[string]$key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
	"  $kind=$key.GetValueKind('Path').ToString()",
	"}",
	"if($kind -ne 'String'){ $kind='ExpandString' }",
	// membership: trim, strip trailing slash/backslash, case-insensitive; skip empties
	"$norm={ param($s) $s.Trim().TrimEnd('\\','/').ToLowerInvariant() }",
	"$target=(& $norm $dir)",
	"$present=$false",
	"foreach($e in ($raw -split ';')){ if($e.Trim() -ne '' -and (& $norm $e) -eq $target){ $present=$true; break } }",
	"if($present){",
	"  $key.Close()",
	"  [Console]::Out.Write((New-Object psobject -Property @{ action='present' } | ConvertTo-Json -Compress))",
	"  exit 0",
	"}",
	// append with a single separator, collapsing a stray trailing one
	"if($raw -eq ''){ $new=$dir } elseif($raw.EndsWith(';')){ $new=\"$raw$dir\" } else { $new=\"$raw;$dir\" }",
	"$rvk=[Microsoft.Win32.RegistryValueKind]::$kind",
	"$key.SetValue('Path',$new,$rvk)",
	"$key.Close()",
	// ponytail: a throwaway-var round-trip fires .NET's built-in
	// WM_SETTINGCHANGE broadcast. Swap for SendMessageTimeout via Add-Type only
	// if a shell ever reports staleness after install.
	"$sig='ADE_PATH_REFRESH'",
	"[Environment]::SetEnvironmentVariable($sig,'1','User')",
	"[Environment]::SetEnvironmentVariable($sig,$null,'User')",
	"[Console]::Out.Write((New-Object psobject -Property @{ action='added' } | ConvertTo-Json -Compress))",
].join("\n");

function defaultWinExec(script: string, env: NodeJS.ProcessEnv): WinExecResult {
	// -EncodedCommand (UTF-16LE base64), not `-Command -` over stdin: Windows
	// PowerShell silently drops a multi-line script's stdout when the block is
	// piped to `-Command -`. Encoding the whole script sidesteps stdin parsing
	// and every layer of shell quoting. Dynamic values ride in on `env`, read
	// back as $env:… — never interpolated into the script.
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const result = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			encoded,
		],
		{ env, encoding: "utf8" },
	);
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

export async function runWinInstall(
	io: LocalIo,
	home: string,
	exec: WinPathExec,
): Promise<number> {
	const binDir = winBinDir(home);
	// Mirror POSIX: without the launcher, adding the dir to PATH would only put
	// a dead entry there. The app writes ade.cmd on boot.
	const launcher = join(binDir, "ade.cmd");
	if (!existsSync(launcher)) {
		io.stderr(`ade cli install: no launcher at ${launcher}`);
		io.stderr("Start the ADE app once — it writes the launcher on boot.");
		return EXIT.USAGE;
	}

	const res = exec(WIN_INSTALL_PATH_PS, { ...process.env, ADE_BIN_DIR: binDir });
	if (res.status !== 0) {
		io.stderr(
			`ade cli install: could not update your user PATH: ${res.stderr.trim() || "powershell exited nonzero"}`,
		);
		return EXIT.USAGE;
	}
	const action = parseInstallResult(res.stdout);
	if (action === null) {
		io.stderr(
			"ade cli install: could not parse the result of the PATH update.",
		);
		return EXIT.USAGE;
	}
	if (action === "present") {
		io.stdout(`Already on PATH: ${binDir}`);
		return EXIT.OK;
	}

	io.stdout(`Installed: added ${binDir} to your user PATH.`);
	io.stdout("");
	io.stdout(
		"Restart your shell (or sign out and back in) for the change to take effect.",
	);
	io.stdout(
		"To undo: remove that entry from Path under Settings → Environment Variables.",
	);
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
			"`ade cli install` puts `ade` on the PATH of terminals ADE did not launch.\n" +
			"  POSIX:   symlinks ~/.ade[-ws]/bin/ade into /usr/local/bin (or ~/.local/bin);\n" +
			"           use --dir to choose one yourself.\n" +
			"  Windows: adds ~/.ade[-ws]\\bin to your user PATH (HKCU\\Environment).\n" +
			"           Restart your shell afterwards; --dir does not apply.\n" +
			"Safe to re-run. There is no `uninstall`: on Windows remove the entry from\n" +
			"Path under Settings → Environment Variables; on POSIX delete the symlink.",
		runLocal: runCli,
	},
];
