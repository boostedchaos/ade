import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktrees } from "@superset/local-db";

// A single temp dir stands in as the one "registered" worktree. The localDb
// mock reports any lookup against the worktrees table as this path, so the
// registered-worktree security boundary passes for it (and validateRelativePath
// still guards traversal independently).
let WORKTREE = "";

let readWorkingFile: typeof import("./changes").readWorkingFile;
let readWorkingFileImage: typeof import("./changes").readWorkingFileImage;
let getFileContents: typeof import("./changes").getFileContents;
let getStatus: typeof import("./changes").getStatus;
let assertRegisteredWorktree: typeof import("./changes").assertRegisteredWorktree;

beforeAll(async () => {
	WORKTREE = mkdtempSync(join(tmpdir(), "ade-changes-"));

	mock.module("./local-db", () => ({
		localDb: {
			select: () => ({
				from: (table: unknown) => ({
					where: () => ({
						get: () =>
							table === worktrees
								? { path: WORKTREE, baseBranch: null }
								: undefined,
					}),
				}),
			}),
		},
	}));

	const mod = await import("./changes");
	readWorkingFile = mod.readWorkingFile;
	readWorkingFileImage = mod.readWorkingFileImage;
	getFileContents = mod.getFileContents;
	getStatus = mod.getStatus;
	assertRegisteredWorktree = mod.assertRegisteredWorktree;
});

afterAll(() => {
	if (WORKTREE) rmSync(WORKTREE, { recursive: true, force: true });
});

describe("changes.readWorkingFile", () => {
	it("reads a text file inside the registered worktree", async () => {
		writeFileSync(join(WORKTREE, "hello.ts"), "export const x = 1;\n");
		const result = await readWorkingFile(WORKTREE, "hello.ts");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.content).toBe("export const x = 1;\n");
			expect(result.byteLength).toBeGreaterThan(0);
		}
	});

	it("reads a nested file", async () => {
		mkdirSync(join(WORKTREE, "src"), { recursive: true });
		writeFileSync(join(WORKTREE, "src", "a.md"), "# Title\n");
		const result = await readWorkingFile(WORKTREE, "src/a.md");
		expect(result).toEqual({
			ok: true,
			content: "# Title\n",
			truncated: false,
			byteLength: 8,
		});
	});

	it("rejects a path that traverses out of the worktree", async () => {
		const result = await readWorkingFile(WORKTREE, "../escape.txt");
		expect(result).toEqual({ ok: false, reason: "outside-worktree" });
	});

	it("rejects an absolute path", async () => {
		const result = await readWorkingFile(WORKTREE, join(tmpdir(), "abs.txt"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("outside-worktree");
	});

	it("reports not-found for a missing file", async () => {
		const result = await readWorkingFile(WORKTREE, "does-not-exist.txt");
		expect(result).toEqual({ ok: false, reason: "not-found" });
	});

	it("detects binary content", async () => {
		writeFileSync(
			join(WORKTREE, "bin.dat"),
			Buffer.from([0x00, 0x01, 0x02, 0x00]),
		);
		const result = await readWorkingFile(WORKTREE, "bin.dat");
		expect(result).toEqual({ ok: false, reason: "binary" });
	});

	it("registered-worktree check passes for the registered path", () => {
		// The registered path resolves without throwing; the boundary itself
		// (rejecting unregistered paths) is covered by the desktop path-validation
		// suite — here the localDb lookup is mocked to report registration.
		expect(() => assertRegisteredWorktree(WORKTREE)).not.toThrow();
	});
});

describe("changes.readWorkingFileImage", () => {
	it("returns a data URL for a supported image", async () => {
		// A 1x1 transparent PNG.
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		);
		writeFileSync(join(WORKTREE, "pixel.png"), png);
		const result = await readWorkingFileImage(WORKTREE, "pixel.png");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
		}
	});

	it("rejects a non-image extension", async () => {
		const result = await readWorkingFileImage(WORKTREE, "hello.ts");
		expect(result).toEqual({ ok: false, reason: "not-image" });
	});
});

describe("changes.getStatus (real git repo)", () => {
	// The localDb mock registers any path, so a throwaway git repo passes the
	// registered-worktree gate.
	let REPO = "";
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: REPO,
			stdio: ["ignore", "pipe", "ignore"],
		});

	beforeAll(() => {
		REPO = mkdtempSync(join(tmpdir(), "ade-status-"));
		git("init", "-b", "main");
		git("config", "user.email", "t@t.dev");
		git("config", "user.name", "T");
		writeFileSync(join(REPO, "tracked.txt"), "one\n");
		git("add", "tracked.txt");
		git("commit", "-m", "init");
		// Now dirty the tree: modify tracked, add untracked.
		writeFileSync(join(REPO, "tracked.txt"), "one\ntwo\n");
		writeFileSync(join(REPO, "fresh.txt"), "brand new\n");
	});

	afterAll(() => {
		if (REPO) rmSync(REPO, { recursive: true, force: true });
	});

	it("reports the modified and untracked files", async () => {
		const status = await getStatus(REPO);
		expect(status.branch).toBe("main");
		expect(status.unstaged.map((f) => f.path)).toContain("tracked.txt");
		expect(status.untracked.map((f) => f.path)).toContain("fresh.txt");
		const tracked = status.unstaged.find((f) => f.path === "tracked.txt");
		expect(tracked?.status).toBe("modified");
		// numstat: one line added to tracked.txt.
		expect(tracked?.additions).toBeGreaterThanOrEqual(1);
	});
});

describe("changes.getFileContents (unstaged, non-git dir)", () => {
	it("returns the working file as `modified` and empty `original`", async () => {
		writeFileSync(join(WORKTREE, "diffed.js"), "const y = 2;\n");
		const result = await getFileContents({
			worktreePath: WORKTREE,
			filePath: "diffed.js",
			category: "unstaged",
		});
		// git show fails in a non-repo dir → original is empty; the working file
		// is returned as `modified`; language detected from the extension.
		expect(result.original).toBe("");
		expect(result.modified).toBe("const y = 2;\n");
		expect(result.language).toBe("javascript");
	});
});
