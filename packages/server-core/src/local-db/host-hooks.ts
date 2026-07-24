/**
 * Host-app hooks for local-db. The DB initializes (and migrates) at module
 * evaluation, so hosts MUST register these before the first local-db import
 * — the desktop does it at the top of main/index.ts; ade-server before
 * mounting routers. Defaults are headless-safe.
 */

export interface LocalDbHostHooks {
	/**
	 * Directory containing drizzle migrations, or null to use the built-in
	 * fallback chain (dist/resources, monorepo source).
	 */
	getMigrationsDir(): string | null;
	/**
	 * A failed migration leaves the schema in an unknown state; continuing
	 * would produce undefined behavior on every query. Report fatally and
	 * terminate. Default: console.error + process.exit(1). The desktop shows
	 * a modal dialog naming the data dir first.
	 */
	onFatalMigrationError(detail: string): void;
}

let hooks: LocalDbHostHooks = {
	getMigrationsDir: () => null,
	onFatalMigrationError: (detail) => {
		console.error(`[local-db] FATAL: ${detail}`);
		process.exit(1);
	},
};

export function setLocalDbHostHooks(next: LocalDbHostHooks): void {
	hooks = next;
}

export function getLocalDbHostHooks(): LocalDbHostHooks {
	return hooks;
}
