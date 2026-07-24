/**
 * Changes / file-viewer backing logic for ade-server.
 *
 * This is the headless port of the desktop `changes` router's read + diff
 * surface (apps/desktop/src/lib/trpc/routers/changes). The desktop version is
 * pure Node + simple-git + localDb — the only Electron coupling was the
 * `main/lib/local-db` import, which is swapped here for the server-core
 * `localDb`. The security model (registered-worktree boundary + symlink-escape
 * checks) is preserved verbatim: a malicious repo must not be able to trick a
 * file-viewer read into escaping the worktree via a symlink.
 *
 * Only the procedures the browser file viewers actually call are ported:
 * readWorkingFile (Monaco/markdown raw), readWorkingFileImage (image preview),
 * getFileContents (diff viewer), and getBranches (against-base diff base).
 * Staging/commit/git-mutation procedures stay desktop-only for now.
 */

import type { Stats } from "node:fs";
import { lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import {
	dirname,
	isAbsolute,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";
import { projects, worktrees } from "@superset/local-db";
import { eq } from "drizzle-orm";
import simpleGit from "simple-git";
import { localDb } from "./local-db";

/** Maximum file size for reading (2 MiB) */
const MAX_FILE_SIZE = 2 * 1024 * 1024;
/** Maximum image file size (10 MiB) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
/** Bytes to scan for binary detection */
const BINARY_CHECK_SIZE = 8192;

// --- Small viewer helpers (ported from apps/desktop/src/shared, which is not
// a shared package, so we inline the two pure functions the viewers need). ---

export function detectLanguage(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase();
	const languageMap: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		xml: "xml",
		toml: "toml",
		md: "markdown",
		mdx: "markdown",
		sh: "shell",
		bash: "shell",
		zsh: "shell",
		fish: "shell",
		dockerfile: "dockerfile",
		makefile: "makefile",
		py: "python",
		rb: "ruby",
		go: "go",
		rs: "rust",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		cpp: "cpp",
		h: "c",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sql: "sql",
		graphql: "graphql",
		gql: "graphql",
	};
	return languageMap[ext || ""] || "plaintext";
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	ico: "image/x-icon",
};

export function getImageMimeType(filePath: string): string | null {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_MIME_TYPES[ext] ?? null;
}

// --- Security: registered-worktree boundary + path validation ---

export type PathValidationErrorCode =
	| "ABSOLUTE_PATH"
	| "PATH_TRAVERSAL"
	| "UNREGISTERED_WORKTREE"
	| "INVALID_TARGET"
	| "SYMLINK_ESCAPE";

export class PathValidationError extends Error {
	constructor(
		message: string,
		public readonly code: PathValidationErrorCode,
	) {
		super(message);
		this.name = "PathValidationError";
	}
}

/**
 * THE security boundary: only worktree paths registered in localDb (or a
 * project's mainRepoPath) are reachable. Prevents the browser from reading
 * arbitrary server paths via the changes router.
 */
export function assertRegisteredWorktree(workspacePath: string): void {
	const worktreeExists = localDb
		.select()
		.from(worktrees)
		.where(eq(worktrees.path, workspacePath))
		.get();
	if (worktreeExists) return;

	const projectExists = localDb
		.select()
		.from(projects)
		.where(eq(projects.mainRepoPath, workspacePath))
		.get();
	if (projectExists) return;

	throw new PathValidationError(
		"Workspace path not registered in database",
		"UNREGISTERED_WORKTREE",
	);
}

export function validateRelativePath(filePath: string): void {
	if (isAbsolute(filePath)) {
		throw new PathValidationError(
			"Absolute paths are not allowed",
			"ABSOLUTE_PATH",
		);
	}
	const normalized = normalize(filePath);
	const segments = normalized.split(sep);
	if (segments.includes("..")) {
		throw new PathValidationError(
			"Path traversal not allowed",
			"PATH_TRAVERSAL",
		);
	}
	if (normalized === "" || normalized === ".") {
		throw new PathValidationError(
			"Cannot target worktree root",
			"INVALID_TARGET",
		);
	}
}

function resolvePathInWorktree(worktreePath: string, filePath: string): string {
	validateRelativePath(filePath);
	return resolve(worktreePath, normalize(filePath));
}

// --- Symlink-escape protection (ported from secure-fs.ts) ---

function isPathWithinWorktree(
	worktreeReal: string,
	targetReal: string,
): boolean {
	if (targetReal === worktreeReal) return true;
	const relativePath = relative(worktreeReal, targetReal);
	const escapes =
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath);
	return !escapes;
}

async function assertParentInWorktree(
	worktreePath: string,
	fullPath: string,
): Promise<void> {
	const worktreeReal = await realpath(worktreePath);
	let currentPath = dirname(fullPath);

	while (currentPath !== dirname(currentPath)) {
		try {
			const stats = await lstat(currentPath);
			if (stats.isSymbolicLink()) {
				const linkTarget = await readlink(currentPath);
				const resolvedTarget = isAbsolute(linkTarget)
					? linkTarget
					: resolve(dirname(currentPath), linkTarget);
				try {
					const targetReal = await realpath(resolvedTarget);
					if (!isPathWithinWorktree(worktreeReal, targetReal)) {
						throw new PathValidationError(
							"Symlink in path resolves outside the worktree",
							"SYMLINK_ESCAPE",
						);
					}
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					) {
						const targetRelative = relative(worktreeReal, resolvedTarget);
						if (
							targetRelative === ".." ||
							targetRelative.startsWith(`..${sep}`) ||
							isAbsolute(targetRelative)
						) {
							throw new PathValidationError(
								"Dangling symlink points outside the worktree",
								"SYMLINK_ESCAPE",
							);
						}
						return;
					}
					if (error instanceof PathValidationError) throw error;
					throw new PathValidationError(
						"Cannot validate symlink target",
						"SYMLINK_ESCAPE",
					);
				}
				return;
			}

			const parentReal = await realpath(currentPath);
			if (!isPathWithinWorktree(worktreeReal, parentReal)) {
				throw new PathValidationError(
					"Parent directory resolves outside the worktree",
					"SYMLINK_ESCAPE",
				);
			}
			return;
		} catch (error) {
			if (error instanceof PathValidationError) throw error;
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				currentPath = dirname(currentPath);
				continue;
			}
			throw new PathValidationError(
				"Cannot validate path ancestry",
				"SYMLINK_ESCAPE",
			);
		}
	}

	throw new PathValidationError(
		"Could not validate path ancestry within worktree",
		"SYMLINK_ESCAPE",
	);
}

async function assertDanglingSymlinkSafe(
	worktreePath: string,
	fullPath: string,
): Promise<void> {
	const worktreeReal = await realpath(worktreePath);
	try {
		const stats = await lstat(fullPath);
		if (stats.isSymbolicLink()) {
			const linkTarget = await readlink(fullPath);
			const resolvedTarget = isAbsolute(linkTarget)
				? linkTarget
				: resolve(dirname(fullPath), linkTarget);
			const targetRelative = relative(worktreeReal, resolvedTarget);
			if (
				targetRelative === ".." ||
				targetRelative.startsWith(`..${sep}`) ||
				isAbsolute(targetRelative)
			) {
				throw new PathValidationError(
					"Dangling symlink points outside the worktree",
					"SYMLINK_ESCAPE",
				);
			}
			return;
		}
		await assertParentInWorktree(worktreePath, fullPath);
	} catch (error) {
		if (error instanceof PathValidationError) throw error;
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			await assertParentInWorktree(worktreePath, fullPath);
			return;
		}
		throw new PathValidationError("Cannot validate path", "SYMLINK_ESCAPE");
	}
}

async function assertRealpathInWorktree(
	worktreePath: string,
	fullPath: string,
): Promise<void> {
	try {
		const real = await realpath(fullPath);
		const worktreeReal = await realpath(worktreePath);
		if (!isPathWithinWorktree(worktreeReal, real)) {
			throw new PathValidationError(
				"File is a symlink pointing outside the worktree",
				"SYMLINK_ESCAPE",
			);
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			await assertDanglingSymlinkSafe(worktreePath, fullPath);
			return;
		}
		if (error instanceof PathValidationError) throw error;
		throw new PathValidationError(
			"Cannot validate file path",
			"SYMLINK_ESCAPE",
		);
	}
}

async function secureStat(
	worktreePath: string,
	filePath: string,
): Promise<Stats> {
	assertRegisteredWorktree(worktreePath);
	const fullPath = resolvePathInWorktree(worktreePath, filePath);
	await assertRealpathInWorktree(worktreePath, fullPath);
	return stat(fullPath);
}

async function secureReadFileBuffer(
	worktreePath: string,
	filePath: string,
): Promise<Buffer> {
	assertRegisteredWorktree(worktreePath);
	const fullPath = resolvePathInWorktree(worktreePath, filePath);
	await assertRealpathInWorktree(worktreePath, fullPath);
	return readFile(fullPath);
}

async function secureReadFile(
	worktreePath: string,
	filePath: string,
): Promise<string> {
	assertRegisteredWorktree(worktreePath);
	const fullPath = resolvePathInWorktree(worktreePath, filePath);
	await assertRealpathInWorktree(worktreePath, fullPath);
	return readFile(fullPath, "utf-8");
}

function isBinaryContent(buffer: Buffer): boolean {
	const checkLength = Math.min(buffer.length, BINARY_CHECK_SIZE);
	for (let i = 0; i < checkLength; i++) {
		if (buffer[i] === 0) return true;
	}
	return false;
}

// --- Public read surface ---

export type ReadWorkingFileResult =
	| { ok: true; content: string; truncated: boolean; byteLength: number }
	| {
			ok: false;
			reason:
				| "not-found"
				| "too-large"
				| "binary"
				| "outside-worktree"
				| "symlink-escape";
	  };

export async function readWorkingFile(
	worktreePath: string,
	filePath: string,
): Promise<ReadWorkingFileResult> {
	try {
		const stats = await secureStat(worktreePath, filePath);
		if (stats.size > MAX_FILE_SIZE) return { ok: false, reason: "too-large" };
		const buffer = await secureReadFileBuffer(worktreePath, filePath);
		if (isBinaryContent(buffer)) return { ok: false, reason: "binary" };
		return {
			ok: true,
			content: buffer.toString("utf-8"),
			truncated: false,
			byteLength: buffer.length,
		};
	} catch (error) {
		if (error instanceof PathValidationError) {
			if (error.code === "SYMLINK_ESCAPE") {
				return { ok: false, reason: "symlink-escape" };
			}
			return { ok: false, reason: "outside-worktree" };
		}
		return { ok: false, reason: "not-found" };
	}
}

export type ReadWorkingFileImageResult =
	| { ok: true; dataUrl: string; byteLength: number }
	| {
			ok: false;
			reason:
				| "not-found"
				| "too-large"
				| "not-image"
				| "outside-worktree"
				| "symlink-escape";
	  };

export async function readWorkingFileImage(
	worktreePath: string,
	filePath: string,
): Promise<ReadWorkingFileImageResult> {
	const mimeType = getImageMimeType(filePath);
	if (!mimeType) return { ok: false, reason: "not-image" };
	try {
		const stats = await secureStat(worktreePath, filePath);
		if (stats.size > MAX_IMAGE_SIZE) return { ok: false, reason: "too-large" };
		const buffer = await secureReadFileBuffer(worktreePath, filePath);
		const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
		return { ok: true, dataUrl, byteLength: buffer.length };
	} catch (error) {
		if (error instanceof PathValidationError) {
			if (error.code === "SYMLINK_ESCAPE") {
				return { ok: false, reason: "symlink-escape" };
			}
			return { ok: false, reason: "outside-worktree" };
		}
		return { ok: false, reason: "not-found" };
	}
}

// --- Diff (getFileContents) ---

export type DiffCategory = "against-base" | "committed" | "staged" | "unstaged";

export interface FileContents {
	original: string;
	modified: string;
	language: string;
}

export interface GetFileContentsInput {
	worktreePath: string;
	filePath: string;
	oldPath?: string;
	category: DiffCategory;
	commitHash?: string;
	defaultBranch?: string;
}

type SimpleGit = ReturnType<typeof simpleGit>;

async function safeGitShow(git: SimpleGit, spec: string): Promise<string> {
	try {
		try {
			const sizeOutput = await git.raw(["cat-file", "-s", spec]);
			const blobSize = Number.parseInt(sizeOutput.trim(), 10);
			if (!Number.isNaN(blobSize) && blobSize > MAX_FILE_SIZE) {
				return `[File content truncated - exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit]`;
			}
		} catch {
			// cat-file failed (blob doesn't exist) — let git.show surface the error
		}
		return await git.show([spec]);
	} catch {
		return "";
	}
}

async function getUnstagedModified(
	worktreePath: string,
	filePath: string,
): Promise<string> {
	try {
		const stats = await secureStat(worktreePath, filePath);
		if (stats.size <= MAX_FILE_SIZE) {
			return await secureReadFile(worktreePath, filePath);
		}
		return `[File content truncated - exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit]`;
	} catch {
		return "";
	}
}

export async function getFileContents(
	input: GetFileContentsInput,
): Promise<FileContents> {
	assertRegisteredWorktree(input.worktreePath);
	const git = simpleGit(input.worktreePath);
	const defaultBranch = input.defaultBranch || "main";
	const originalPath = input.oldPath || input.filePath;

	let original = "";
	let modified = "";

	switch (input.category) {
		case "against-base":
			[original, modified] = await Promise.all([
				safeGitShow(git, `origin/${defaultBranch}:${originalPath}`),
				safeGitShow(git, `HEAD:${input.filePath}`),
			]);
			break;
		case "committed": {
			if (!input.commitHash) {
				throw new Error("commitHash required for committed category");
			}
			[original, modified] = await Promise.all([
				safeGitShow(git, `${input.commitHash}^:${originalPath}`),
				safeGitShow(git, `${input.commitHash}:${input.filePath}`),
			]);
			break;
		}
		case "staged":
			[original, modified] = await Promise.all([
				safeGitShow(git, `HEAD:${originalPath}`),
				safeGitShow(git, `:0:${input.filePath}`),
			]);
			break;
		case "unstaged": {
			original = await safeGitShow(git, `:0:${originalPath}`);
			if (!original) original = await safeGitShow(git, `HEAD:${originalPath}`);
			modified = await getUnstagedModified(input.worktreePath, input.filePath);
			break;
		}
	}

	return { original, modified, language: detectLanguage(input.filePath) };
}

// --- Branches (getBranches) ---

export interface GetBranchesResult {
	local: Array<{ branch: string; lastCommitDate: number }>;
	remote: string[];
	defaultBranch: string;
	checkedOutBranches: Record<string, string>;
	worktreeBaseBranch: string | null;
}

async function getLocalBranchesWithDates(
	git: SimpleGit,
	localBranches: string[],
): Promise<Array<{ branch: string; lastCommitDate: number }>> {
	try {
		const branchInfo = await git.raw([
			"for-each-ref",
			"--sort=-committerdate",
			"--format=%(refname:short) %(committerdate:unix)",
			"refs/heads/",
		]);
		const local: Array<{ branch: string; lastCommitDate: number }> = [];
		for (const line of branchInfo.trim().split("\n")) {
			if (!line) continue;
			const lastSpaceIdx = line.lastIndexOf(" ");
			const branch = line.substring(0, lastSpaceIdx);
			const timestamp = Number.parseInt(line.substring(lastSpaceIdx + 1), 10);
			if (localBranches.includes(branch)) {
				local.push({ branch, lastCommitDate: timestamp * 1000 });
			}
		}
		return local;
	} catch {
		return localBranches.map((branch) => ({ branch, lastCommitDate: 0 }));
	}
}

async function getDefaultBranch(
	git: SimpleGit,
	remoteBranches: string[],
): Promise<string> {
	try {
		const headRef = await git.raw(["symbolic-ref", "refs/remotes/origin/HEAD"]);
		const match = headRef.match(/refs\/remotes\/origin\/(.+)/);
		if (match) return match[1].trim();
	} catch {
		if (remoteBranches.includes("master") && !remoteBranches.includes("main")) {
			return "master";
		}
	}
	return "main";
}

async function getCheckedOutBranches(
	git: SimpleGit,
	currentWorktreePath: string,
): Promise<Record<string, string>> {
	const checkedOut: Record<string, string> = {};
	try {
		const worktreeList = await git.raw(["worktree", "list", "--porcelain"]);
		let currentPath: string | null = null;
		for (const line of worktreeList.split("\n")) {
			if (line.startsWith("worktree ")) {
				currentPath = line.substring(9).trim();
			} else if (line.startsWith("branch ")) {
				const branch = line.substring(7).trim().replace("refs/heads/", "");
				if (currentPath && currentPath !== currentWorktreePath) {
					checkedOut[branch] = currentPath;
				}
			}
		}
	} catch {
		// no worktree list available
	}
	return checkedOut;
}

/**
 * Ported from the desktop branches router, minus the git-config base-branch
 * layer (desktop reads a per-branch git config file; server-side we fall back
 * to the persisted `worktrees.baseBranch` column, which is what the desktop
 * uses when no explicit config is set).
 */
export async function getBranches(
	worktreePath: string,
): Promise<GetBranchesResult> {
	assertRegisteredWorktree(worktreePath);
	const git = simpleGit(worktreePath);

	const branchSummary = await git.branch(["-a"]);
	const localBranches: string[] = [];
	const remote: string[] = [];
	for (const name of Object.keys(branchSummary.branches)) {
		if (name.startsWith("remotes/origin/")) {
			if (name === "remotes/origin/HEAD") continue;
			remote.push(name.replace("remotes/origin/", ""));
		} else {
			localBranches.push(name);
		}
	}

	const [local, defaultBranch, checkedOutBranches] = await Promise.all([
		getLocalBranchesWithDates(git, localBranches),
		getDefaultBranch(git, remote),
		getCheckedOutBranches(git, worktreePath),
	]);

	const persisted = localDb
		.select({ baseBranch: worktrees.baseBranch })
		.from(worktrees)
		.where(eq(worktrees.path, worktreePath))
		.get();

	return {
		local,
		remote: remote.sort(),
		defaultBranch,
		checkedOutBranches,
		worktreeBaseBranch: persisted?.baseBranch?.trim() || null,
	};
}

// --- Status (getStatus / getCommitFiles) ---
// Ported from the desktop changes/status router. The desktop uses a
// lock-tolerant `getStatusNoLock`; server-side we call simple-git's `.status()`
// directly (same StatusResult shape) — the index.lock race the desktop guards
// against is a concurrent-git-command concern that doesn't arise for these
// read-only status queries.

export type FileStatus =
	| "added"
	| "modified"
	| "deleted"
	| "renamed"
	| "copied"
	| "untracked";

export interface ChangedFile {
	path: string;
	oldPath?: string;
	status: FileStatus;
	additions: number;
	deletions: number;
}

export interface CommitInfo {
	hash: string;
	shortHash: string;
	message: string;
	author: string;
	date: Date;
	files: ChangedFile[];
}

export interface GitChangesStatus {
	branch: string;
	defaultBranch: string;
	againstBase: ChangedFile[];
	commits: CommitInfo[];
	staged: ChangedFile[];
	unstaged: ChangedFile[];
	untracked: ChangedFile[];
	ahead: number;
	behind: number;
	pushCount: number;
	pullCount: number;
	hasUpstream: boolean;
}

type GitStatusResult = Awaited<ReturnType<SimpleGit["status"]>>;

function mapGitStatus(gitIndex: string, gitWorking: string): FileStatus {
	if (gitIndex === "A" || gitWorking === "A") return "added";
	if (gitIndex === "D" || gitWorking === "D") return "deleted";
	if (gitIndex === "R") return "renamed";
	if (gitIndex === "C") return "copied";
	if (gitIndex === "?" || gitWorking === "?") return "untracked";
	return "modified";
}

function parseGitStatus(
	status: GitStatusResult,
): Pick<GitChangesStatus, "branch" | "staged" | "unstaged" | "untracked"> {
	const staged: ChangedFile[] = [];
	const unstaged: ChangedFile[] = [];
	const untracked: ChangedFile[] = [];

	for (const file of status.files) {
		const path = file.path;
		const index = file.index;
		const working = file.working_dir;

		if (index === "?" && working === "?") {
			untracked.push({ path, status: "untracked", additions: 0, deletions: 0 });
			continue;
		}
		if (index && index !== " " && index !== "?") {
			staged.push({
				path,
				oldPath: file.path !== file.from ? file.from : undefined,
				status: mapGitStatus(index, " "),
				additions: 0,
				deletions: 0,
			});
		}
		if (working && working !== " " && working !== "?") {
			unstaged.push({
				path,
				status: mapGitStatus(" ", working),
				additions: 0,
				deletions: 0,
			});
		}
	}

	return { branch: status.current || "HEAD", staged, unstaged, untracked };
}

function parseGitLog(logOutput: string): CommitInfo[] {
	if (!logOutput.trim()) return [];
	const commits: CommitInfo[] = [];
	for (const line of logOutput.trim().split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("|");
		if (parts.length < 5) continue;
		const hash = parts[0]?.trim();
		const shortHash = parts[1]?.trim();
		const message = parts.slice(2, -2).join("|").trim();
		const author = parts[parts.length - 2]?.trim();
		const dateStr = parts[parts.length - 1]?.trim();
		if (!hash || !shortHash) continue;
		const parsed = dateStr ? new Date(dateStr) : new Date();
		const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
		commits.push({
			hash,
			shortHash,
			message: message || "",
			author: author || "",
			date,
			files: [],
		});
	}
	return commits;
}

function parseDiffNumstat(
	numstatOutput: string,
): Map<string, { additions: number; deletions: number }> {
	const stats = new Map<string, { additions: number; deletions: number }>();
	for (const line of numstatOutput.trim().split("\n")) {
		if (!line.trim()) continue;
		const [addStr, delStr, ...pathParts] = line.split("\t");
		const rawPath = pathParts.join("\t");
		if (!rawPath) continue;
		const additions = addStr === "-" ? 0 : Number.parseInt(addStr, 10) || 0;
		const deletions = delStr === "-" ? 0 : Number.parseInt(delStr, 10) || 0;
		const entry = { additions, deletions };
		const renameMatch = rawPath.match(/^(.+) => (.+)$/);
		if (renameMatch) {
			stats.set(renameMatch[2], entry);
			stats.set(renameMatch[1], entry);
		} else {
			stats.set(rawPath, entry);
		}
	}
	return stats;
}

function parseNameStatus(nameStatusOutput: string): ChangedFile[] {
	const files: ChangedFile[] = [];
	for (const line of nameStatusOutput.trim().split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		const statusCode = parts[0];
		if (!statusCode) continue;
		const isRenameOrCopy =
			statusCode.startsWith("R") || statusCode.startsWith("C");
		const path = isRenameOrCopy ? parts[2] : parts[1];
		const oldPath = isRenameOrCopy ? parts[1] : undefined;
		if (!path) continue;
		let status: FileStatus;
		switch (statusCode[0]) {
			case "A":
				status = "added";
				break;
			case "D":
				status = "deleted";
				break;
			case "R":
				status = "renamed";
				break;
			case "C":
				status = "copied";
				break;
			default:
				status = "modified";
		}
		files.push({ path, oldPath, status, additions: 0, deletions: 0 });
	}
	return files;
}

async function applyNumstatToFiles(
	git: SimpleGit,
	files: ChangedFile[],
	diffArgs: string[],
): Promise<void> {
	if (files.length === 0) return;
	try {
		const stats = parseDiffNumstat(await git.raw(diffArgs));
		for (const file of files) {
			const fileStat = stats.get(file.path);
			if (fileStat) {
				file.additions = fileStat.additions;
				file.deletions = fileStat.deletions;
			}
		}
	} catch {
		// numstat unavailable — leave counts at zero
	}
}

const MAX_LINE_COUNT_SIZE = 1 * 1024 * 1024;

async function applyUntrackedLineCount(
	worktreePath: string,
	untracked: ChangedFile[],
): Promise<void> {
	for (const file of untracked) {
		try {
			const stats = await secureStat(worktreePath, file.path);
			if (stats.size > MAX_LINE_COUNT_SIZE) continue;
			const content = await secureReadFile(worktreePath, file.path);
			file.additions = content.split("\n").length;
			file.deletions = 0;
		} catch {
			// unreadable/escaping untracked file — skip line count
		}
	}
}

async function getBranchComparison(
	git: SimpleGit,
	defaultBranch: string,
): Promise<{
	commits: CommitInfo[];
	againstBase: ChangedFile[];
	ahead: number;
	behind: number;
}> {
	let commits: CommitInfo[] = [];
	let againstBase: ChangedFile[] = [];
	let ahead = 0;
	let behind = 0;
	try {
		const tracking = await git.raw([
			"rev-list",
			"--left-right",
			"--count",
			`origin/${defaultBranch}...HEAD`,
		]);
		const [behindStr, aheadStr] = tracking.trim().split(/\s+/);
		behind = Number.parseInt(behindStr || "0", 10);
		ahead = Number.parseInt(aheadStr || "0", 10);

		commits = parseGitLog(
			await git.raw([
				"log",
				`origin/${defaultBranch}..HEAD`,
				"--format=%H|%h|%s|%an|%aI",
			]),
		);

		if (ahead > 0) {
			againstBase = parseNameStatus(
				await git.raw([
					"diff",
					"--name-status",
					`origin/${defaultBranch}...HEAD`,
				]),
			);
			await applyNumstatToFiles(git, againstBase, [
				"diff",
				"--numstat",
				`origin/${defaultBranch}...HEAD`,
			]);
		}
	} catch {
		// no origin/<defaultBranch> to compare against (e.g. local-only repo)
	}
	return { commits, againstBase, ahead, behind };
}

async function getTrackingBranchStatus(
	git: SimpleGit,
): Promise<{ pushCount: number; pullCount: number; hasUpstream: boolean }> {
	try {
		const upstream = await git.raw([
			"rev-parse",
			"--abbrev-ref",
			"@{upstream}",
		]);
		if (!upstream.trim())
			return { pushCount: 0, pullCount: 0, hasUpstream: false };
		const tracking = await git.raw([
			"rev-list",
			"--left-right",
			"--count",
			"@{upstream}...HEAD",
		]);
		const [pullStr, pushStr] = tracking.trim().split(/\s+/);
		return {
			pushCount: Number.parseInt(pushStr || "0", 10),
			pullCount: Number.parseInt(pullStr || "0", 10),
			hasUpstream: true,
		};
	} catch {
		return { pushCount: 0, pullCount: 0, hasUpstream: false };
	}
}

export class NotGitRepoError extends Error {}

export async function getStatus(
	worktreePath: string,
	defaultBranchInput?: string,
): Promise<GitChangesStatus> {
	assertRegisteredWorktree(worktreePath);
	const defaultBranch = defaultBranchInput || "main";
	const git = simpleGit(worktreePath);

	let status: GitStatusResult;
	try {
		status = await git.status();
	} catch (error) {
		throw new NotGitRepoError(
			error instanceof Error ? error.message : "Not a git repository",
		);
	}
	const parsed = parseGitStatus(status);

	const [branchComparison, trackingStatus] = await Promise.all([
		getBranchComparison(git, defaultBranch),
		getTrackingBranchStatus(git),
		applyNumstatToFiles(git, parsed.staged, ["diff", "--cached", "--numstat"]),
		applyNumstatToFiles(git, parsed.unstaged, ["diff", "--numstat"]),
		applyUntrackedLineCount(worktreePath, parsed.untracked),
	]);

	return {
		branch: parsed.branch,
		defaultBranch,
		againstBase: branchComparison.againstBase,
		commits: branchComparison.commits,
		staged: parsed.staged,
		unstaged: parsed.unstaged,
		untracked: parsed.untracked,
		ahead: branchComparison.ahead,
		behind: branchComparison.behind,
		pushCount: trackingStatus.pushCount,
		pullCount: trackingStatus.pullCount,
		hasUpstream: trackingStatus.hasUpstream,
	};
}

export async function getCommitFiles(
	worktreePath: string,
	commitHash: string,
): Promise<ChangedFile[]> {
	assertRegisteredWorktree(worktreePath);
	const git = simpleGit(worktreePath);
	const files = parseNameStatus(
		await git.raw([
			"diff-tree",
			"--no-commit-id",
			"--name-status",
			"-r",
			commitHash,
		]),
	);
	await applyNumstatToFiles(git, files, [
		"diff-tree",
		"--no-commit-id",
		"--numstat",
		"-r",
		commitHash,
	]);
	return files;
}
