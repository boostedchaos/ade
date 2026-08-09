import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ADE_BIN_MARKER,
	ADE_BIN_MARKER_CMD,
	adeCliEntryCandidates,
	buildAdeBinCmd,
	buildAdeBinScript,
	findRepoRoot,
	resolveAdeCliEntry,
} from "./ade-cli-bin";

const ENTRY = { entryPath: "/repo/packages/cli/src/index.ts" };

describe("adeCliEntryCandidates", () => {
	it("prefers a packaged resources entry over the repo source", () => {
		const candidates = adeCliEntryCandidates({
			appResourcesDir: "/res",
			repoRoot: "/repo",
		});
		expect(candidates[0]).toBe(join("/res", "cli", "index.mjs"));
		expect(candidates[candidates.length - 1]).toBe(
			join("/repo", "packages", "cli", "src", "index.ts"),
		);
	});

	it("prefers a compiled repo entry over the TypeScript source", () => {
		expect(adeCliEntryCandidates({ repoRoot: "/repo" })).toEqual([
			join("/repo", "packages", "cli", "dist", "index.mjs"),
			join("/repo", "packages", "cli", "src", "index.ts"),
		]);
	});

	it("returns nothing when neither location is known", () => {
		expect(adeCliEntryCandidates({})).toEqual([]);
	});
});

describe("resolveAdeCliEntry", () => {
	it("returns the first candidate that exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "ade-cli-entry-"));
		const real = join(dir, "index.mjs");
		writeFileSync(real, "");
		expect(resolveAdeCliEntry([join(dir, "missing.mjs"), real])).toBe(real);
	});

	it("returns null when none exist", () => {
		expect(resolveAdeCliEntry(["/definitely/not/here.mjs"])).toBeNull();
	});
});

describe("findRepoRoot", () => {
	it("finds the directory holding packages/cli/package.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "ade-repo-"));
		mkdirSync(join(dir, "packages", "cli"), { recursive: true });
		writeFileSync(join(dir, "packages", "cli", "package.json"), "{}");
		expect(findRepoRoot(join(dir, "packages", "cli"))).toBe(dir);
	});

	it("returns undefined when there is no such ancestor", () => {
		expect(
			findRepoRoot(mkdtempSync(join(tmpdir(), "ade-norepo-"))),
		).toBeUndefined();
	});

	it("locates this repo's root from the module's own directory", () => {
		// Guards the dev-checkout fallback: if this ever returns undefined in
		// the repo, agents silently lose the `ade` bin.
		expect(findRepoRoot()).toBeTruthy();
	});

	it("resolves to a root whose packages/cli/src/index.ts really exists", () => {
		// Pins the ruled contract to reality rather than to a string: the entry
		// the launcher will bake must be a file that is actually there.
		const root = findRepoRoot();
		expect(root).toBeTruthy();
		const entry = resolveAdeCliEntry(
			adeCliEntryCandidates({ repoRoot: root as string }),
		);
		expect(entry).toBeTruthy();
		expect(entry?.endsWith(join("packages", "cli", "src", "index.ts"))).toBe(
			true,
		);
	});
});

describe("buildAdeBinScript — the ruled contract", () => {
	const script = buildAdeBinScript(ENTRY);

	it("uses a /bin/sh shebang, not bash", () => {
		expect(script.startsWith("#!/bin/sh\n")).toBe(true);
	});

	it("carries the marker so the file is recognisable as generated", () => {
		expect(script).toContain(ADE_BIN_MARKER);
	});

	it("execs bun against the entry, forwarding argv verbatim", () => {
		expect(script).toContain('exec bun "$ADE_ENTRY" "$@"');
	});

	it("bakes the resolved entry path", () => {
		expect(script).toContain(ENTRY.entryPath);
	});

	it("lets ADE_CLI_ENTRY override the baked path", () => {
		expect(script).toContain('ADE_ENTRY="${ADE_CLI_ENTRY:-');
	});

	it("exits 127 when the entry file is gone, not 3", () => {
		// 3 is reserved by PROTOCOL.md for "ADE app not running"; a launcher
		// failure must not be mistakable for a server-state answer.
		expect(script).toContain("exit 127");
		expect(script).not.toMatch(/exit 3\b/);
	});

	it("exits 2 with a named reason when bun is not on PATH", () => {
		expect(script).toContain("command -v bun");
		expect(script).toContain("exit 2");
		expect(script).toContain("bun is required");
	});

	it("adds no arguments of its own", () => {
		const execLines = script
			.split("\n")
			.filter((line) => line.startsWith("exec "));
		expect(execLines).toEqual(['exec bun "$ADE_ENTRY" "$@"']);
	});

	it("never invokes node — bun is the only runtime in the ruled contract", () => {
		expect(script).not.toContain("ELECTRON_RUN_AS_NODE");
		expect(script).not.toMatch(/\bnode\b/);
	});
});

describe("buildAdeBinCmd", () => {
	const cmd = buildAdeBinCmd(ENTRY);

	it("carries the Windows marker", () => {
		expect(cmd).toContain(ADE_BIN_MARKER_CMD);
	});

	it("uses CRLF line endings like the other Windows shims", () => {
		expect(cmd.includes("\r\n")).toBe(true);
	});

	it("runs bun, forwards %*, and propagates the exit code", () => {
		expect(cmd).toContain('bun "%ADE_ENTRY%" %*');
		expect(cmd).toContain("exit /b %ERRORLEVEL%");
	});

	it("exits 2 when bun is not on PATH", () => {
		expect(cmd).toContain("where bun");
		expect(cmd).toContain("exit /b 2");
	});

	it("exits 127 when the entry file is gone, not 3", () => {
		expect(cmd).toContain("exit /b 127");
		expect(cmd).not.toMatch(/exit \/b 3\b/);
	});

	it("escapes percent signs in the baked path", () => {
		expect(buildAdeBinCmd({ entryPath: "C:\\a%b\\index.ts" })).toContain(
			"a%%b",
		);
	});
});
