import fs from "node:fs";
import path from "node:path";
import { ADE_DATA_DIR_NAME_ENV } from "@superset/shared/constants";
import { SUPERSET_DIR_NAME } from "../constants";
import { IS_WINDOWS, writeFileIfChanged } from "./agent-wrappers-common";
import { BIN_DIR, CLI_DIR } from "./paths";

/**
 * Puts the `ade` CLI on every agent terminal's PATH.
 *
 * WHY NOTHING ELSE CHANGES: BIN_DIR (~/.ade[-ws]/bin) is ALREADY prepended to
 * PATH by all three mechanisms — the generated zsh/bash/fish rc files
 * (shell-wrappers.ts `_superset_prepend_bin`, re-applied in .zlogin so mise or
 * nvm cannot shadow it) and win32's getShellEnv. Dropping an executable here
 * is the whole integration. Deliberately NOT added to SHIMMED_BINARIES: that
 * list intercepts THIRD-PARTY binaries (claude, codex, …) with wrapper
 * scripts, and a shell function named `ade` would only add a failure mode.
 */

export const ADE_BIN_NAME = "ade";
export const ADE_BIN_MARKER = "# ADE CLI launcher";
export const ADE_BIN_MARKER_CMD = "REM ADE CLI launcher";

/**
 * THE BIN-INVOCATION CONTRACT, as ruled by the CLI lane (2026-08-09):
 *
 *   #!/bin/sh
 *   exec bun "<repo>/packages/cli/src/index.ts" "$@"
 *
 * Notes that go with it:
 *   - `packages/cli/src/index.ts` is the bin entry and carries its own
 *     `#!/usr/bin/env bun`. It uses node builtins only, so the same file also
 *     runs under node once compiled. Nothing may IMPORT it — importing runs
 *     the CLI; the library surface is `packages/cli/src/lib.ts`.
 *   - `$ADE_CLI_ENTRY` overrides the baked path, for dev and for tests.
 *   - The baked path is the STAGED copy under `<home>/<adeDir>/cli/` when the
 *     resolved entry came from the packaged (read-only) resources dir — bun
 *     cannot execute a script from a directory the user cannot write to. See
 *     stageBundledCliEntry.
 *   - The launcher defaults `$ADE_DATA_DIR_NAME` to the generating app's data
 *     dir before exec'ing, so the CLI finds the right control socket even
 *     from a plain external shell. An already-set value is never overwritten.
 *   - Argv is transparent: the launcher adds no arguments of its own and
 *     `exec` hands the CLI's exit code straight back.
 *   - The launcher's own failure exits are 2 (bun missing) and 127 (entry file
 *     missing — "command not found", the shell's own convention). 127 rather
 *     than 3 by ruling: PROTOCOL.md reserves 3 for "ADE app not running", and
 *     a launcher failure must not be mistakable for a server-state answer.
 *
 * RISK worth stating rather than burying: this hard-requires `bun` on the
 * agent's PATH. The rc files prepend BIN_DIR, not a bun install, so an agent
 * terminal on a machine without bun gets exit 2 from every `ade` call. A
 * compiled `.js`/`.mjs` entry run through Electron-as-Node would remove that
 * dependency; the resolution order below already prefers a compiled entry if
 * one is ever produced, so adopting it later needs no change here.
 */
export interface AdeCliEntry {
	/** Absolute path to the CLI entry file. */
	entryPath: string;
	/**
	 * Data-dir name of the app that generated this launcher (e.g. ".ade" or
	 * ".ade-default"). Baked in and exported only when the caller has not
	 * already set it, so a symlink to this launcher works from a plain
	 * external terminal — one that has no ADE_* env at all — while an agent
	 * terminal's injected value still wins. Defaults to SUPERSET_DIR_NAME.
	 */
	dataDirName?: string;
}

/**
 * Candidate entry paths, most-specific first. `appResourcesDir` is where a
 * packaged build would place a compiled CLI; in a dev checkout only the
 * TypeScript source exists, which is what the ruled contract points at.
 */
export function adeCliEntryCandidates(params: {
	appResourcesDir?: string;
	repoRoot?: string;
}): string[] {
	const candidates: string[] = [];
	if (params.appResourcesDir) {
		candidates.push(path.join(params.appResourcesDir, "cli", "index.mjs"));
		candidates.push(path.join(params.appResourcesDir, "cli", "index.js"));
	}
	if (params.repoRoot) {
		candidates.push(
			path.join(params.repoRoot, "packages", "cli", "dist", "index.mjs"),
		);
		candidates.push(
			path.join(params.repoRoot, "packages", "cli", "src", "index.ts"),
		);
	}
	return candidates;
}

/** First candidate that exists on disk, or null. */
export function resolveAdeCliEntry(candidates: string[]): string | null {
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			// unreadable candidate is simply not a candidate
		}
	}
	return null;
}

/**
 * Walk up from this module looking for the monorepo root (the directory that
 * contains packages/cli). Returns undefined in a packaged build, where the
 * source tree is not present and appResourcesDir is the right lookup instead.
 */
export function findRepoRoot(startDir = __dirname): string | undefined {
	let dir = startDir;
	for (let depth = 0; depth < 10; depth += 1) {
		try {
			if (fs.existsSync(path.join(dir, "packages", "cli", "package.json"))) {
				return dir;
			}
		} catch {
			// keep walking
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/**
 * THE FIELD BUG (0.4.0, Windows): the launcher baked
 * `C:\Program Files\ADE\resources\cli\index.mjs` and every installed `ade` call
 * died with `error: EPERM reading <path>`. bun 1.3.x refuses to EXECUTE an entry
 * script that lives in a directory the user cannot write to — the file is
 * perfectly readable (readFileSync works, and the same bytes run fine from a
 * temp dir). So the packaged bundle is copied into the app's own data dir and
 * the launcher points there instead.
 *
 * Only the PACKAGED entry is staged: a dev checkout's entry is TypeScript source
 * that imports siblings (uncopyable) and already sits in a writable tree.
 * Copied unconditionally on every injection, so an upgrade refreshes the staged
 * copy — agent-setup runs on each app boot.
 */
export function stageBundledCliEntry(
	entryPath: string,
	appResourcesDir?: string,
	targetDir: string = CLI_DIR,
): string {
	if (!appResourcesDir) return entryPath;
	const resourcesPrefix = path.resolve(appResourcesDir) + path.sep;
	if (!path.resolve(entryPath).startsWith(resourcesPrefix)) return entryPath;
	const staged = path.join(targetDir, path.basename(entryPath));
	try {
		fs.mkdirSync(targetDir, { recursive: true });
		// Copy to a sibling temp name and rename over the target: a plain
		// copyFileSync truncates first, so a crash (or a concurrent `ade` call
		// reading it) mid-copy would leave a half-written entry that bun cannot
		// run. rename within the same dir is atomic.
		const tmp = `${staged}.${process.pid}.tmp`;
		fs.copyFileSync(entryPath, tmp);
		fs.renameSync(tmp, staged);
		return staged;
	} catch (error) {
		// A previously staged copy is still executable; the packaged path is not
		// (that IS the 0.4.0 bug), so a failed refresh keeps the stale-but-working
		// copy. Either way say why rather than degrading silently.
		let stagedExists = false;
		try {
			stagedExists = fs.existsSync(staged);
		} catch {
			// unreadable target counts as absent
		}
		console.warn(
			stagedExists
				? `[agent-setup] Could not refresh the ade CLI in ${targetDir}; keeping the previously staged copy at ${staged}: ${error}`
				: `[agent-setup] Could not stage the ade CLI into ${targetDir}; the launcher will point at the packaged copy, which bun cannot execute on Windows: ${error}`,
		);
		return stagedExists ? staged : entryPath;
	}
}

export function getAdeBinPath(): string {
	return path.join(BIN_DIR, IS_WINDOWS ? `${ADE_BIN_NAME}.cmd` : ADE_BIN_NAME);
}

/**
 * Escape a path for a double-quoted sh string. A no-op for ordinary POSIX
 * paths; it exists because the Windows shim bakes `C:\…`, where a segment
 * starting with `$` or a backtick would otherwise be expanded by sh. Backslash
 * doubling is harmless — sh collapses it back to the literal path.
 */
function escapeForShDoubleQuotes(value: string): string {
	return value.replace(/[\\$`"]/g, (ch) => `\\${ch}`);
}

/** POSIX launcher, exactly the ruled shape. Pure so it can be asserted. */
export function buildAdeBinScript(entry: AdeCliEntry): string {
	const dataDirName = entry.dataDirName ?? SUPERSET_DIR_NAME;
	return `#!/bin/sh
${ADE_BIN_MARKER}
# Generated by agent-setup. Edits are overwritten on the next app launch.

: "\${${ADE_DATA_DIR_NAME_ENV}:=${dataDirName}}"
export ${ADE_DATA_DIR_NAME_ENV}
ADE_ENTRY="\${ADE_CLI_ENTRY:-${escapeForShDoubleQuotes(entry.entryPath)}}"
if [ ! -f "$ADE_ENTRY" ]; then
  echo "ade: CLI entry not found at $ADE_ENTRY" >&2
  exit 127
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "ade: bun is required to run the ADE CLI and is not on PATH" >&2
  exit 2
fi
exec bun "$ADE_ENTRY" "$@"
`;
}

/** Windows launcher. Same contract; cmd.exe spelling. */
export function buildAdeBinCmd(entry: AdeCliEntry): string {
	const safeEntry = entry.entryPath.replaceAll("%", "%%");
	const dataDirName = (entry.dataDirName ?? SUPERSET_DIR_NAME).replaceAll(
		"%",
		"%%",
	);
	return [
		"@echo off",
		ADE_BIN_MARKER_CMD,
		"setlocal",
		`if "%${ADE_DATA_DIR_NAME_ENV}%"=="" (set "${ADE_DATA_DIR_NAME_ENV}=${dataDirName}")`,
		`if "%ADE_CLI_ENTRY%"=="" (set "ADE_ENTRY=${safeEntry}") else (set "ADE_ENTRY=%ADE_CLI_ENTRY%")`,
		'if not exist "%ADE_ENTRY%" (',
		"  echo ade: CLI entry not found at %ADE_ENTRY% 1>&2",
		"  exit /b 127",
		")",
		"where bun >nul 2>&1",
		"if errorlevel 1 (",
		"  echo ade: bun is required to run the ADE CLI and is not on PATH 1>&2",
		"  exit /b 2",
		")",
		'bun "%ADE_ENTRY%" %*',
		"exit /b %ERRORLEVEL%",
		"",
	].join("\r\n");
}

/**
 * Materialise the launcher. Uses the package's writeFileIfChanged idempotency
 * helper, because setupAgentHooks() runs on every app boot and unconditional
 * writes would churn mtimes and defeat the "if changed" logging.
 */
export function createAdeCliBin(params?: {
	appResourcesDir?: string;
	repoRoot?: string;
	/** Test seams. Default to the real ~/.ade locations. */
	binPath?: string;
	cliDir?: string;
}): void {
	const resolved = {
		// Electron sets process.resourcesPath at runtime; it is absent from the
		// Node type surface (this package must stay Electron-free), and
		// undefined under plain node/bun.
		appResourcesDir:
			params?.appResourcesDir ??
			(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
		repoRoot: params?.repoRoot ?? findRepoRoot(),
	};
	const resolvedEntry = resolveAdeCliEntry(adeCliEntryCandidates(resolved));
	if (!resolvedEntry) {
		// A missing CLI must not fail agent setup — the rest of the hooks are
		// still valuable. Logged loudly because a silent skip here is exactly
		// the "graceful degradation nobody reads" failure mode.
		console.warn(
			"[agent-setup] Skipped ade CLI launcher: no CLI entry found. Agents will not have `ade` on PATH.",
		);
		return;
	}

	const entryPath = stageBundledCliEntry(
		resolvedEntry,
		resolved.appResourcesDir,
		params?.cliDir,
	);
	const entry: AdeCliEntry = { entryPath };
	const binPath = params?.binPath ?? getAdeBinPath();
	const changed = writeFileIfChanged(
		binPath,
		IS_WINDOWS ? buildAdeBinCmd(entry) : buildAdeBinScript(entry),
		0o755,
	);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} ade CLI launcher → ${entryPath}`,
	);

	// THE 0.4.1 GAP: Windows agent panes default to Git Bash, and bash does NOT
	// resolve `.cmd` files bare from PATH — `ade` exited 127 while `ade.cmd`
	// worked. So win32 gets BOTH: cmd.exe reads ade.cmd, sh reads this
	// extensionless sibling. Same contract, same baked entry (a `C:\…` path in
	// double quotes survives sh and bun accepts it); the POSIX builder already
	// produces LF-only, BOM-free content, which a shebang script requires.
	if (IS_WINDOWS) {
		const shimPath = path.join(path.dirname(binPath), ADE_BIN_NAME);
		const shimChanged = writeFileIfChanged(
			shimPath,
			buildAdeBinScript(entry),
			0o755,
		);
		console.log(
			`[agent-setup] ${shimChanged ? "Updated" : "Verified"} ade CLI sh shim (bash panes) → ${shimPath}`,
		);
	}
}
