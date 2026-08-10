import { describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPERSET_DIR_NAME } from "../constants";
import {
	ADE_BIN_MARKER,
	ADE_BIN_MARKER_CMD,
	adeCliEntryCandidates,
	buildAdeBinCmd,
	buildAdeBinScript,
	createAdeCliBin,
	findRepoRoot,
	resolveAdeCliEntry,
	stageBundledCliEntry,
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

describe("stageBundledCliEntry — the installed-CLI EPERM fix", () => {
	// THE BUG (0.4.0): the launcher baked
	// C:\Program Files\ADE\resources\cli\index.mjs and bun refused to execute it
	// ("error: EPERM reading …") because the directory is not user-writable.
	function packagedFixture(bundle = "bundle-v1") {
		const root = mkdtempSync(join(tmpdir(), "ade-stage-"));
		const resources = join(root, "resources");
		mkdirSync(join(resources, "cli"), { recursive: true });
		const entry = join(resources, "cli", "index.mjs");
		writeFileSync(entry, bundle);
		return { root, resources, entry, dataDir: join(root, ".ade", "cli") };
	}

	it("copies a packaged entry into the writable data dir", () => {
		const f = packagedFixture();
		const staged = stageBundledCliEntry(f.entry, f.resources, f.dataDir);
		expect(staged).toBe(join(f.dataDir, "index.mjs"));
		expect(readFileSync(staged, "utf8")).toBe("bundle-v1");
	});

	it("overwrites the staged copy on every injection, so upgrades refresh it", () => {
		const f = packagedFixture();
		const staged = stageBundledCliEntry(f.entry, f.resources, f.dataDir);
		writeFileSync(f.entry, "bundle-v2");
		expect(stageBundledCliEntry(f.entry, f.resources, f.dataDir)).toBe(staged);
		expect(readFileSync(staged, "utf8")).toBe("bundle-v2");
	});

	it("keeps using an already-staged copy when a refresh fails", () => {
		// An upgrade that cannot re-copy (locked file, gone bundle) must NOT send
		// the launcher back to the read-only packaged path — the stale staged copy
		// is the only one bun can execute.
		const f = packagedFixture();
		const staged = stageBundledCliEntry(f.entry, f.resources, f.dataDir);
		rmSync(f.entry); // source vanishes → copy throws, staged copy survives
		expect(stageBundledCliEntry(f.entry, f.resources, f.dataDir)).toBe(staged);
		expect(readFileSync(staged, "utf8")).toBe("bundle-v1");
	});

	it("falls back to the packaged entry when staging fails with nothing staged", () => {
		const f = packagedFixture();
		// A file where the target dir should be: mkdir/copy cannot succeed.
		const blocker = join(f.root, "blocker");
		writeFileSync(blocker, "");
		expect(
			stageBundledCliEntry(f.entry, f.resources, join(blocker, "cli")),
		).toBe(f.entry);
	});

	it("leaves a dev-checkout entry where it is", () => {
		// The repo entry is TypeScript source that imports siblings — copying it
		// would break it, and its tree is writable anyway.
		const f = packagedFixture();
		const repoEntry = join(f.root, "packages", "cli", "src", "index.ts");
		expect(stageBundledCliEntry(repoEntry, f.resources, f.dataDir)).toBe(
			repoEntry,
		);
	});
});

describe("createAdeCliBin — launcher points at the staged copy", () => {
	it("stages the packaged bundle and bakes the staged path", () => {
		const root = mkdtempSync(join(tmpdir(), "ade-inject-"));
		const resources = join(root, "resources");
		mkdirSync(join(resources, "cli"), { recursive: true });
		writeFileSync(join(resources, "cli", "index.mjs"), "bundle-v1");
		const cliDir = join(root, ".ade", "cli");
		const binDir = join(root, ".ade", "bin");
		mkdirSync(binDir, { recursive: true }); // agent-setup creates BIN_DIR itself
		const binPath = join(binDir, "ade");

		createAdeCliBin({ appResourcesDir: resources, cliDir, binPath });

		const staged = join(cliDir, "index.mjs");
		expect(readFileSync(staged, "utf8")).toBe("bundle-v1");
		const launcher = readFileSync(binPath, "utf8");
		expect(launcher).toContain(staged);
		expect(launcher).not.toContain(join(resources, "cli", "index.mjs"));
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

	it("defaults ADE_DATA_DIR_NAME to the generating app's dir and exports it", () => {
		const withDir = buildAdeBinScript({ ...ENTRY, dataDirName: ".ade-probe" });
		// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting sh syntax
		expect(withDir).toContain(': "${ADE_DATA_DIR_NAME:=.ade-probe}"');
		expect(withDir).toContain("export ADE_DATA_DIR_NAME");
	});

	it("uses := so an already-set ADE_DATA_DIR_NAME is never overwritten", () => {
		// An agent terminal already carries the app's value; the launcher must
		// only fill the gap for a plain external shell.
		expect(script).toContain(":=");
		expect(script).not.toMatch(/^ADE_DATA_DIR_NAME=/m);
	});

	it("bakes SUPERSET_DIR_NAME when no dir name is supplied", () => {
		expect(script).toContain(`:=${SUPERSET_DIR_NAME}}"`);
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

	it("sets ADE_DATA_DIR_NAME only when the caller left it empty", () => {
		const withDir = buildAdeBinCmd({ ...ENTRY, dataDirName: ".ade-probe" });
		expect(withDir).toContain(
			'if "%ADE_DATA_DIR_NAME%"=="" (set "ADE_DATA_DIR_NAME=.ade-probe")',
		);
	});

	it("bakes SUPERSET_DIR_NAME when no dir name is supplied", () => {
		expect(cmd).toContain(`set "ADE_DATA_DIR_NAME=${SUPERSET_DIR_NAME}"`);
	});
});
