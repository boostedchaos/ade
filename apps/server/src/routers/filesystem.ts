import {
	access,
	mkdir,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod/v4";
import { authedProcedure, router } from "../trpc";

/** Max size for a by-path text read (2 MiB), matching the desktop viewer cap. */
const MAX_BY_PATH_SIZE = 2 * 1024 * 1024;

/** Detect binary content by scanning the leading bytes for a NUL. */
function isBinaryBuffer(buffer: Buffer): boolean {
	const checkLength = Math.min(buffer.length, 8192);
	for (let i = 0; i < checkLength; i++) {
		if (buffer[i] === 0) return true;
	}
	return false;
}

interface DirectoryEntry {
	id: string;
	name: string;
	path: string;
	relativePath: string;
	isDirectory: boolean;
}

/**
 * Filesystem router — mirrors the desktop paths the Agent Files panel calls.
 * Reads happen on the server (where the agent worktrees live); the browser
 * only ever sees the resulting tree/content.
 */
export const filesystemRouter = router({
	readDirectory: authedProcedure
		.input(
			z.object({
				dirPath: z.string(),
				rootPath: z.string(),
				includeHidden: z.boolean().default(false),
			}),
		)
		.query(async ({ input }): Promise<DirectoryEntry[]> => {
			try {
				const entries = await readdir(input.dirPath, { withFileTypes: true });
				return entries
					.filter((e) => input.includeHidden || !e.name.startsWith("."))
					.map((e) => {
						const fullPath = join(input.dirPath, e.name);
						return {
							id: relative(input.rootPath, fullPath),
							name: e.name,
							path: fullPath,
							relativePath: relative(input.rootPath, fullPath),
							isDirectory: e.isDirectory(),
						};
					})
					.sort((a, b) =>
						a.isDirectory !== b.isDirectory
							? a.isDirectory
								? -1
								: 1
							: a.name.localeCompare(b.name),
					);
			} catch {
				return [];
			}
		}),

	readFile: authedProcedure
		.input(z.object({ filePath: z.string() }))
		.query(async ({ input }) => {
			try {
				return { content: await readFile(input.filePath, "utf8") };
			} catch (error) {
				return {
					content: "",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}),

	/** Mirrors the desktop filesystem.createNote mutation used by the "+" tab-strip button. */
	createNote: authedProcedure
		.input(
			z.object({
				rootPath: z.string(),
				name: z.string().optional(),
				content: z.string().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			const notesDir = join(input.rootPath, ".ade", "notes");
			await mkdir(notesDir, { recursive: true });

			const now = new Date();
			const dateStr = now.toISOString().slice(0, 10);
			const timeStr = now.toTimeString().slice(0, 5).replace(":", "");
			const baseName = input.name
				? input.name.replace(/[^a-zA-Z0-9_-]/g, "-")
				: `${dateStr}-${timeStr}`;
			const fileName = `${baseName}.md`;
			const filePath = join(notesDir, fileName);

			// If file exists, append a counter.
			let finalPath = filePath;
			let counter = 1;
			while (true) {
				try {
					await access(finalPath);
					finalPath = join(notesDir, `${baseName}-${counter}.md`);
					counter++;
				} catch {
					break;
				}
			}

			const header = input.name ? `# ${input.name}` : `# Note — ${dateStr}`;
			const body = input.content ?? "";
			await writeFile(finalPath, `${header}\n\n${body}\n`, "utf-8");

			// Return path relative to rootPath for file-viewer.
			return { relativePath: relative(input.rootPath, finalPath) };
		}),

	/**
	 * Read a text file by ABSOLUTE path — used by the file-viewer panes for
	 * files that live outside the worktree (e.g. an agent's memory/skill files
	 * under the agent-home dir). Mirrors the desktop filesystem.readFileByPath
	 * shape so the viewer content loader consumes either interchangeably.
	 */
	readFileByPath: authedProcedure
		.input(z.object({ absolutePath: z.string() }))
		.query(
			async ({
				input,
			}): Promise<
				| { ok: true; content: string; truncated: boolean; byteLength: number }
				| { ok: false; reason: "not-found" | "too-large" | "binary" }
			> => {
				try {
					const stats = await stat(input.absolutePath);
					if (!stats.isFile()) return { ok: false, reason: "not-found" };
					if (stats.size > MAX_BY_PATH_SIZE) {
						return { ok: false, reason: "too-large" };
					}
					const buffer = await readFile(input.absolutePath);
					if (isBinaryBuffer(buffer)) return { ok: false, reason: "binary" };
					return {
						ok: true,
						content: buffer.toString("utf-8"),
						truncated: false,
						byteLength: buffer.length,
					};
				} catch {
					return { ok: false, reason: "not-found" };
				}
			},
		),

	stat: authedProcedure
		.input(z.object({ path: z.string() }))
		.query(async ({ input }) => {
			try {
				const stats = await stat(input.path);
				return {
					size: stats.size,
					isDirectory: stats.isDirectory(),
					isFile: stats.isFile(),
					isSymbolicLink: stats.isSymbolicLink(),
					createdAt: stats.birthtime.toISOString(),
					modifiedAt: stats.mtime.toISOString(),
					accessedAt: stats.atime.toISOString(),
				};
			} catch {
				return null;
			}
		}),

	exists: authedProcedure
		.input(z.object({ path: z.string() }))
		.query(async ({ input }) => {
			try {
				const stats = await stat(input.path);
				return {
					exists: true,
					isDirectory: stats.isDirectory(),
					isFile: stats.isFile(),
				};
			} catch {
				return { exists: false, isDirectory: false, isFile: false };
			}
		}),
});
