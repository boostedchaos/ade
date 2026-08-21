/**
 * Locate the Claude Code CLI the ACP adapter should drive.
 *
 * Phase 2 bundles `@agentclientprotocol/claude-agent-acp` and its SDK WITHOUT
 * the SDK's vendored per-platform CLI package
 * (`@anthropic-ai/claude-agent-sdk-darwin-arm64`, 246 MB, an
 * `optionalDependency`). Two reasons, both from the repo's own position:
 * README line 58 — "Argus orchestrates coding CLIs; it does not bundle them" —
 * and a bundled copy drifting from the Claude Code the user actually runs.
 *
 * Without that package the adapter says so itself:
 *   "Claude native binary not found for darwin-arm64. Reinstall
 *    @anthropic-ai/claude-agent-sdk without --omit=optional, or set
 *    CLAUDE_CODE_EXECUTABLE."
 * So `CLAUDE_CODE_EXECUTABLE` is the seam, and this module fills it.
 *
 * The lookup is a pure function over injected IO so the not-found path — the
 * one that must render a readable message instead of hanging — is unit
 * testable without touching the machine's real PATH.
 */

import { accessSync, closeSync, constants, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Marker every ADE agent-wrapper shim carries in its header comment. */
const WRAPPER_MARKER = "agent-wrapper";

/** How much of a candidate to read when sniffing for the wrapper marker. */
const HEAD_BYTES = 512;

export interface ClaudeLookupIo {
	/** Raw `PATH`, colon/semicolon separated. */
	pathValue: string | undefined;
	home: string;
	/** Explicit override (`CLAUDE_CODE_EXECUTABLE`), honoured before any search. */
	override?: string | undefined;
	pathSeparator: string;
	isExecutableFile: (candidate: string) => boolean;
	/** First `HEAD_BYTES` of a file as text; "" when unreadable. */
	readHead: (candidate: string) => string;
}

export interface ClaudeLookupResult {
	path: string;
	/** Where it came from, for logging — never used to branch. */
	source: "override" | "path" | "well-known";
}

/**
 * Directories holding ADE's own `claude` shim, which must never be chosen.
 *
 * The shim `exec`s the real binary with `--settings <ade hooks settings>`
 * appended, which registers the pane-status hook set. Under ACP that would
 * give the pane a SECOND status writer competing with the in-band one (D5), on
 * top of injecting a flag the SDK's own argv assembly never asked for.
 */
function isWrapperDir(dir: string, home: string): boolean {
	const normalized = dir.replace(/[/\\]+$/, "");
	if (!normalized.startsWith(`${home}/`)) return false;
	const segments = normalized.slice(home.length + 1).split("/");
	if (segments.length !== 2 || segments[1] !== "bin") return false;
	// ~/.superset/bin, ~/.ade/bin, and per-agent homes like ~/.ade-default/bin.
	const root = segments[0] ?? "";
	return root === ".superset" || /^\.ade(-.+)?$/.test(root);
}

function isWrapperScript(candidate: string, io: ClaudeLookupIo): boolean {
	return io.readHead(candidate).includes(WRAPPER_MARKER);
}

/**
 * Well-known install locations, searched only after `PATH` misses.
 *
 * The desktop app's `PATH` is Electron's, which on macOS is the truncated
 * launchd one when the app is opened from Finder — so a `claude` that every
 * shell can see is routinely invisible here. Checking the standard install
 * roots directly is what keeps "works in my terminal" from becoming "the pane
 * says not installed".
 */
function wellKnownCandidates(home: string): string[] {
	return [
		join(home, ".local", "bin", "claude"),
		join(home, ".claude", "local", "claude"),
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
		"/usr/bin/claude",
	];
}

/** The resolved CLI, or null when nothing on this machine looks like one. */
export function findClaudeExecutable(
	io: ClaudeLookupIo,
): ClaudeLookupResult | null {
	const override = io.override?.trim();
	if (override) {
		// An override that does not exist is NOT quietly replaced by a search:
		// silently ignoring it would run a different CLI than the one named.
		return io.isExecutableFile(override)
			? { path: override, source: "override" }
			: null;
	}

	for (const rawDir of io.pathValue?.split(io.pathSeparator) ?? []) {
		const dir = rawDir.trim();
		if (!dir) continue;
		if (isWrapperDir(dir, io.home)) continue;
		const candidate = join(dir, "claude");
		if (!io.isExecutableFile(candidate)) continue;
		if (isWrapperScript(candidate, io)) continue;
		return { path: candidate, source: "path" };
	}

	for (const candidate of wellKnownCandidates(io.home)) {
		if (!io.isExecutableFile(candidate)) continue;
		if (isWrapperScript(candidate, io)) continue;
		return { path: candidate, source: "well-known" };
	}

	return null;
}

/** Message shown in the pane's status line when the lookup comes up empty. */
export function claudeNotFoundMessage(override?: string): string {
	if (override?.trim()) {
		return (
			`CLAUDE_CODE_EXECUTABLE points at "${override.trim()}", which is not an ` +
			"executable file. Correct it, or unset it to search PATH."
		);
	}
	return (
		"Claude Code was not found on this machine. Argus runs your own install " +
		"rather than bundling one. Install it with `npm i -g @anthropic-ai/claude-code` " +
		"(https://claude.com/claude-code), or set CLAUDE_CODE_EXECUTABLE to the " +
		"full path of your `claude` binary, then create the pane again."
	);
}

// =============================================================================
// Real IO
// =============================================================================

function isExecutableFile(candidate: string): boolean {
	try {
		accessSync(candidate, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function readHead(candidate: string): string {
	let fd: number | null = null;
	try {
		fd = openSync(candidate, "r");
		const buffer = Buffer.alloc(HEAD_BYTES);
		const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
		return buffer.toString("utf8", 0, read);
	} catch {
		return "";
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

export function defaultClaudeLookupIo(
	env: NodeJS.ProcessEnv = process.env,
): ClaudeLookupIo {
	return {
		pathValue: env.PATH ?? env.Path,
		home: env.HOME ?? homedir(),
		override: env.CLAUDE_CODE_EXECUTABLE,
		pathSeparator: process.platform === "win32" ? ";" : ":",
		isExecutableFile,
		readHead,
	};
}
