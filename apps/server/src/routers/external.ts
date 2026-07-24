import { localDb } from "@ade/server-core/local-db";
import {
	type ExternalApp,
	EXTERNAL_APPS,
	NON_EDITOR_APPS,
	projects,
	settings,
} from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
	copyToClipboard,
	getAppCommand,
	getOpenCommand,
	resolvePath,
	revealInFileManager,
	spawnAsync,
} from "../lib/external-apps";
import { authedProcedure, router } from "../trpc";

/**
 * External-apps router — server mirror of the desktop `external` paths (open
 * URL/path/app, reveal in file manager, copy path, open-in-editor). Used by
 * file trees, diff views, and terminal file links across the shared
 * renderer, so a missing mirror here breaks those surfaces on web with a
 * "No procedure found" error. Command resolution is platform-aware (desktop's
 * own resolver is macOS-only via `open -a`/`open -b`); see ../lib/external-apps.
 */

const ExternalAppSchema = z.enum(EXTERNAL_APPS);
const nonEditorSet = new Set<ExternalApp>(NON_EDITOR_APPS);

function ensureGlobalDefaultEditor(app: ExternalApp) {
	if (nonEditorSet.has(app)) return;

	const row = localDb.select().from(settings).get();
	if (!row?.defaultEditor) {
		localDb
			.insert(settings)
			.values({ id: 1, defaultEditor: app })
			.onConflictDoUpdate({
				target: settings.id,
				set: { defaultEditor: app },
			})
			.run();
	}
}

function resolveDefaultEditor(projectId?: string): ExternalApp | null {
	if (projectId) {
		const project = localDb
			.select()
			.from(projects)
			.where(eq(projects.id, projectId))
			.get();
		if (project?.defaultApp) return project.defaultApp;
	}
	const row = localDb.select().from(settings).get();
	return row?.defaultEditor ?? null;
}

async function openPathInApp(
	filePath: string,
	app: ExternalApp,
): Promise<void> {
	if (app === "finder") {
		await revealInFileManager(filePath);
		return;
	}

	const candidates = getAppCommand(app, filePath);
	if (candidates) {
		let lastError: Error | undefined;
		for (const cmd of candidates) {
			try {
				await spawnAsync(cmd.command, cmd.args);
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				if (candidates.length > 1) {
					console.warn(
						`[external/openInApp] ${cmd.args[0]} not found, trying next candidate`,
					);
				}
			}
		}
		throw lastError;
	}

	// No known launcher for this app on this platform — fall back to the OS
	// default handler rather than failing outright.
	const { command, args } = getOpenCommand(filePath);
	await spawnAsync(command, args);
}

export const externalRouter = router({
	openUrl: authedProcedure.input(z.string()).mutation(async ({ input }) => {
		try {
			const { command, args } = getOpenCommand(input);
			await spawnAsync(command, args);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			console.error("[external/openUrl] Failed to open URL:", input, error);
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: errorMessage,
			});
		}
	}),

	openInFinder: authedProcedure
		.input(z.string())
		.mutation(async ({ input }) => {
			await revealInFileManager(input);
		}),

	openInApp: authedProcedure
		.input(
			z.object({
				path: z.string(),
				app: ExternalAppSchema,
				projectId: z.string().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			try {
				await openPathInApp(input.path, input.app);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: errorMessage,
				});
			}

			if (input.projectId) {
				localDb
					.update(projects)
					.set({ defaultApp: input.app })
					.where(eq(projects.id, input.projectId))
					.run();
			}

			try {
				ensureGlobalDefaultEditor(input.app);
			} catch (err) {
				console.warn(
					"[external/openInApp] Failed to persist global default editor:",
					err,
				);
			}
		}),

	copyPath: authedProcedure.input(z.string()).mutation(async ({ input }) => {
		try {
			await copyToClipboard(input);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: errorMessage,
			});
		}
	}),

	openFileInEditor: authedProcedure
		.input(
			z.object({
				path: z.string(),
				line: z.number().optional(),
				column: z.number().optional(),
				cwd: z.string().optional(),
				projectId: z.string().optional(),
			}),
		)
		.mutation(async ({ input }) => {
			const filePath = resolvePath(input.path, input.cwd);
			const app = resolveDefaultEditor(input.projectId) ?? "cursor";

			try {
				await openPathInApp(filePath, app);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: errorMessage,
				});
			}
		}),
});
