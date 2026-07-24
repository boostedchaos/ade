// Electron-specific local-db host hooks. MUST evaluate before
// @ade/server-core/local-db (the DB opens and migrates at module scope)
// — the local-db shim imports this module first to guarantee it.
import { join } from "node:path";
import { setLocalDbHostHooks } from "@ade/server-core/local-db/host-hooks";
import { app, dialog } from "electron";
import { env } from "../../env.main";

setLocalDbHostHooks({
	getMigrationsDir: () => {
		const isElectron =
			typeof app?.getAppPath === "function" &&
			typeof app?.isPackaged === "boolean";
		if (isElectron && app.isPackaged) {
			// Production (packaged .app): resources/migrations/
			return join(process.resourcesPath, "resources/migrations");
		}
		if (isElectron && env.NODE_ENV === "development") {
			// Development: source files in monorepo
			return join(app.getAppPath(), "../../packages/local-db/drizzle");
		}
		// Preview/test: let the package's fallback chain resolve it.
		return null;
	},
	onFatalMigrationError: (detail) => {
		if (app?.isReady?.() === undefined) {
			console.error(`[local-db] FATAL: ${detail}`);
			process.exit(1);
			return;
		}
		const showFatal = () => {
			// showErrorBox is modal + safe before "ready"; app.exit bypasses the
			// before-quit confirmation dialog (which itself reads the now-broken DB).
			dialog.showErrorBox("ADE failed to start", detail);
			app.exit(1);
		};
		if (app.isReady()) {
			showFatal();
		} else {
			app.on("ready", showFatal);
		}
	},
});
