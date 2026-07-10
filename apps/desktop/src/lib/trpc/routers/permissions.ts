import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { shell, systemPreferences } from "electron";
import { publicProcedure, router } from "..";

/**
 * These permission checks and prompts are macOS TCC concepts (Full Disk Access,
 * Accessibility, Microphone, Apple Events, Local Network). None apply on
 * Windows/Linux, and several of the electron `systemPreferences` calls throw
 * off-darwin. On non-darwin the renderer hides the Permissions settings
 * section, but guard the router too so any stray call returns benign
 * "not applicable" values instead of throwing.
 */
const IS_DARWIN = process.platform === "darwin";

function checkFullDiskAccess(): boolean {
	try {
		// Safari bookmarks are TCC-protected — readable only with Full Disk Access
		const tccProtectedPath = path.join(
			homedir(),
			"Library/Safari/Bookmarks.plist",
		);
		fs.accessSync(tccProtectedPath, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function checkAccessibility(): boolean {
	return systemPreferences.isTrustedAccessibilityClient(false);
}

function checkMicrophone(): boolean {
	try {
		return systemPreferences.getMediaAccessStatus("microphone") === "granted";
	} catch {
		return false;
	}
}

export const createPermissionsRouter = () => {
	return router({
		getStatus: publicProcedure.query(() => {
			if (!IS_DARWIN) {
				// Not applicable off-darwin — report "granted" so nothing in the UI
				// gates on a permission the OS doesn't have.
				return {
					fullDiskAccess: true,
					accessibility: true,
					microphone: true,
				};
			}
			return {
				fullDiskAccess: checkFullDiskAccess(),
				accessibility: checkAccessibility(),
				microphone: checkMicrophone(),
			};
		}),

		requestFullDiskAccess: publicProcedure.mutation(async () => {
			if (!IS_DARWIN) return;
			await shell.openExternal(
				"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
			);
		}),

		requestAccessibility: publicProcedure.mutation(async () => {
			if (!IS_DARWIN) return;
			await shell.openExternal(
				"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
			);
		}),

		requestMicrophone: publicProcedure.mutation(async () => {
			if (!IS_DARWIN) return { granted: true };
			try {
				const granted = await systemPreferences.askForMediaAccess("microphone");
				if (granted) {
					return { granted: true };
				}
			} catch {
				// Fall through to opening System Settings.
			}

			await shell.openExternal(
				"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
			);
			return { granted: false };
		}),

		requestAppleEvents: publicProcedure.mutation(async () => {
			if (!IS_DARWIN) return;
			await shell.openExternal(
				"x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
			);
		}),

		// No deep link exists for Local Network — open the general Privacy & Security pane
		requestLocalNetwork: publicProcedure.mutation(async () => {
			if (!IS_DARWIN) return;
			await shell.openExternal(
				"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
			);
		}),
	});
};

export type PermissionsRouter = ReturnType<typeof createPermissionsRouter>;
