import {
	DEFAULT_OPEN_LINKS_IN_APP,
	DEFAULT_SHOW_RESOURCE_MONITOR,
} from "@ade/server-core/constants";
import { localDb } from "@ade/server-core/local-db";
import {
	clearProviderKey,
	getProviderKeyStatus,
	PROVIDER_IDS,
	setProviderKey,
} from "@ade/server-core/provider-keys";
import { BRANCH_PREFIX_MODES, settings } from "@superset/local-db";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { getGitAuthorName, getGitHubUsername } from "../lib/git";
import { authedProcedure, router } from "../trpc";

function getSettingsRow() {
	return localDb.select().from(settings).where(eq(settings.id, 1)).get();
}

const setFontSettingsSchema = z.object({
	terminalFontFamily: z.string().max(500).nullable().optional(),
	terminalFontSize: z.number().int().min(10).max(24).nullable().optional(),
	editorFontFamily: z.string().max(500).nullable().optional(),
	editorFontSize: z.number().int().min(10).max(24).nullable().optional(),
});

function transformFontSettings(
	input: z.infer<typeof setFontSettingsSchema>,
): Record<string, string | number | null> {
	const set: Record<string, string | number | null> = {};

	if (input.terminalFontFamily !== undefined) {
		set.terminalFontFamily = input.terminalFontFamily?.trim() || null;
	}
	if (input.terminalFontSize !== undefined) {
		set.terminalFontSize = input.terminalFontSize;
	}
	if (input.editorFontFamily !== undefined) {
		set.editorFontFamily = input.editorFontFamily?.trim() || null;
	}
	if (input.editorFontSize !== undefined) {
		set.editorFontSize = input.editorFontSize;
	}

	return set;
}

/**
 * Minimal stubs for desktop router paths the renderer calls at boot but
 * which have no headless behavior yet. Each is a candidate for a real
 * implementation as Phase 2 hardening continues.
 */

export const settingsRouter = router({
	/** Ringtones are a desktop nicety; none selected headless. */
	getSelectedRingtoneId: authedProcedure.query(() => null),

	// Notification sound mute — the web shell reads this to decide whether its
	// Web Notifications are silent (mirrors the desktop ringtone toggle).
	// Persisted in the same `settings` row (id=1) the desktop uses.
	getNotificationSoundsMuted: authedProcedure.query(() => {
		const row = localDb.select().from(settings).get();
		return row?.notificationSoundsMuted ?? false;
	}),

	setNotificationSoundsMuted: authedProcedure
		.input(z.object({ muted: z.boolean() }))
		.mutation(({ input }) => {
			localDb
				.insert(settings)
				.values({ id: 1, notificationSoundsMuted: input.muted })
				.onConflictDoUpdate({
					target: settings.id,
					set: { notificationSoundsMuted: input.muted },
				})
				.run();
			return { success: true };
		}),

	// Resource-monitor visibility — backs the TopBar ResourceConsumption panel.
	// Same semantics/table as desktop (default off; persisted in the settings row).
	getShowResourceMonitor: authedProcedure.query(() => {
		const row = localDb
			.select({ showResourceMonitor: settings.showResourceMonitor })
			.from(settings)
			.where(eq(settings.id, 1))
			.get();
		return row?.showResourceMonitor ?? DEFAULT_SHOW_RESOURCE_MONITOR;
	}),

	setShowResourceMonitor: authedProcedure
		.input(z.object({ enabled: z.boolean() }))
		.mutation(({ input }) => {
			localDb
				.insert(settings)
				.values({ id: 1, showResourceMonitor: input.enabled })
				.onConflictDoUpdate({
					target: settings.id,
					set: { showResourceMonitor: input.enabled },
				})
				.run();
			return { success: true };
		}),

	// Branch prefix / git identity / worktree / link / font settings — same
	// `settings` row (id=1) semantics as the desktop, backing the Behavior and
	// Appearance settings pages plus the Terminal and Monaco font readers.
	getBranchPrefix: authedProcedure.query(() => {
		const row = getSettingsRow();
		return {
			mode: row?.branchPrefixMode ?? "none",
			customPrefix: row?.branchPrefixCustom ?? null,
		};
	}),

	setBranchPrefix: authedProcedure
		.input(
			z.object({
				mode: z.enum(BRANCH_PREFIX_MODES),
				customPrefix: z.string().nullable().optional(),
			}),
		)
		.mutation(({ input }) => {
			localDb
				.insert(settings)
				.values({
					id: 1,
					branchPrefixMode: input.mode,
					branchPrefixCustom: input.customPrefix ?? null,
				})
				.onConflictDoUpdate({
					target: settings.id,
					set: {
						branchPrefixMode: input.mode,
						branchPrefixCustom: input.customPrefix ?? null,
					},
				})
				.run();
			return { success: true };
		}),

	getGitInfo: authedProcedure.query(async () => {
		const githubUsername = await getGitHubUsername();
		const authorName = await getGitAuthorName();
		return {
			githubUsername,
			authorName,
			authorPrefix: authorName?.toLowerCase().replace(/\s+/g, "-") ?? null,
		};
	}),

	getDeleteLocalBranch: authedProcedure.query(
		() => getSettingsRow()?.deleteLocalBranch ?? false,
	),

	setDeleteLocalBranch: authedProcedure
		.input(z.object({ enabled: z.boolean() }))
		.mutation(({ input }) => {
			localDb
				.insert(settings)
				.values({ id: 1, deleteLocalBranch: input.enabled })
				.onConflictDoUpdate({
					target: settings.id,
					set: { deleteLocalBranch: input.enabled },
				})
				.run();
			return { success: true };
		}),

	getWorktreeBaseDir: authedProcedure.query(
		() => getSettingsRow()?.worktreeBaseDir ?? null,
	),

	setWorktreeBaseDir: authedProcedure
		.input(z.object({ path: z.string().nullable() }))
		.mutation(({ input }) => {
			localDb
				.insert(settings)
				.values({ id: 1, worktreeBaseDir: input.path })
				.onConflictDoUpdate({
					target: settings.id,
					set: { worktreeBaseDir: input.path },
				})
				.run();
			return { success: true };
		}),

	getOpenLinksInApp: authedProcedure.query(
		() => getSettingsRow()?.openLinksInApp ?? DEFAULT_OPEN_LINKS_IN_APP,
	),

	setOpenLinksInApp: authedProcedure
		.input(z.object({ enabled: z.boolean() }))
		.mutation(({ input }) => {
			localDb
				.insert(settings)
				.values({ id: 1, openLinksInApp: input.enabled })
				.onConflictDoUpdate({
					target: settings.id,
					set: { openLinksInApp: input.enabled },
				})
				.run();
			return { success: true };
		}),

	getFontSettings: authedProcedure.query(() => {
		const row = getSettingsRow();
		return {
			terminalFontFamily: row?.terminalFontFamily ?? null,
			terminalFontSize: row?.terminalFontSize ?? null,
			editorFontFamily: row?.editorFontFamily ?? null,
			editorFontSize: row?.editorFontSize ?? null,
		};
	}),

	setFontSettings: authedProcedure
		.input(setFontSettingsSchema)
		.mutation(({ input }) => {
			const set = transformFontSettings(input);
			if (Object.keys(set).length === 0) {
				return { success: true };
			}
			localDb
				.insert(settings)
				.values({ id: 1, ...set })
				.onConflictDoUpdate({
					target: settings.id,
					set,
				})
				.run();
			return { success: true };
		}),

	// Provider API keys — encrypted at rest via the server's file-key
	// SecretStore. The renderer only ever learns presence; the key itself is
	// never returned.
	providerKeys: router({
		status: authedProcedure.query(() => getProviderKeyStatus()),

		set: authedProcedure
			.input(
				z.object({
					provider: z.enum(PROVIDER_IDS),
					key: z.string().refine((v) => v.trim().length > 0, {
						message: "API key must not be empty",
					}),
				}),
			)
			.mutation(({ input }) => {
				try {
					setProviderKey(input.provider, input.key);
				} catch (error) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message:
							error instanceof Error
								? error.message
								: "Failed to store provider key",
					});
				}
				return { success: true };
			}),

		clear: authedProcedure
			.input(z.object({ provider: z.enum(PROVIDER_IDS) }))
			.mutation(({ input }) => {
				clearProviderKey(input.provider);
				return { success: true };
			}),
	}),
});

export const syncRouter = router({
	/** Cross-window app-state sync — single-window web has nothing to sync yet. */
	appStateUpdates: authedProcedure.subscription(() =>
		observable<never>(() => () => {}),
	),
});
