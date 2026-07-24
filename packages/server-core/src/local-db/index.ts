import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as schema from "@superset/local-db";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { validate as uuidValidate, version as uuidVersion } from "uuid";
import {
	ensureSupersetHomeDirExists,
	SUPERSET_HOME_DIR,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "../app-environment";
import { getLocalDbHostHooks } from "./host-hooks";

const DB_PATH = join(SUPERSET_HOME_DIR, "local.db");

ensureSupersetHomeDirExists();

/**
 * Gets the migrations directory path.
 *
 * Path resolution strategy:
 * - Production (packaged .app): resources/migrations/
 * - Development (NODE_ENV=development): packages/local-db/drizzle/
 * - Preview (electron-vite preview): dist/resources/migrations/
 * - Test environment: Use monorepo path relative to __dirname
 */
function getMigrationsDirectory(): string {
	// Host-specific locations first (packaged Electron resources,
	// app-path-relative dev source) — registered via LocalDbHostHooks.
	const hostDir = getLocalDbHostHooks().getMigrationsDir();
	if (hostDir) return hostDir;

	// Built output: __dirname is the bundle dir; builds ship migrations under
	// a sibling resources/ dir.
	const previewPath = join(__dirname, "../resources/migrations");
	if (existsSync(previewPath)) {
		return previewPath;
	}

	// Monorepo source (tests, bun-run dev):
	// packages/server-core/src/local-db -> packages/local-db/drizzle
	const monorepoPath = join(
		__dirname,
		"../../../../packages/local-db/drizzle",
	);
	if (existsSync(monorepoPath)) {
		return monorepoPath;
	}

	console.warn(`[local-db] Migrations directory not found at: ${previewPath}`);
	return previewPath;
}

const migrationsFolder = getMigrationsDirectory();

const sqlite = new Database(DB_PATH);
try {
	chmodSync(DB_PATH, SUPERSET_SENSITIVE_FILE_MODE);
} catch {
	// Best-effort; directory permissions should still protect the DB.
}
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = OFF");
sqlite.function("uuid_v4", () => randomUUID());
sqlite.function("uuid_is_valid_v4", (value: unknown) => {
	if (typeof value !== "string") return 0;
	if (!uuidValidate(value)) return 0;
	return uuidVersion(value) === 4 ? 1 : 0;
});

console.log(`[local-db] Database initialized at: ${DB_PATH}`);
console.log(`[local-db] Running migrations from: ${migrationsFolder}`);

export const localDb = drizzle(sqlite, { schema });

try {
	migrate(localDb, { migrationsFolder });
} catch (error) {
	// A failed migration leaves the schema in an unknown state; continuing would
	// produce undefined behavior on every query. Report fatally via the host
	// hook (dialog + app.exit on desktop; stderr + process.exit headless),
	// naming the data dir so the user can inspect/back up the DB.
	console.error("[local-db] Migration failed:", error);
	const message = error instanceof Error ? error.message : String(error);
	const detail = [
		"ADE could not initialize its local database.",
		"",
		`Database: ${DB_PATH}`,
		`Migrations: ${migrationsFolder}`,
		"",
		message,
	].join("\n");
	getLocalDbHostHooks().onFatalMigrationError(detail);
	throw error;
}

console.log("[local-db] Migrations complete");

export type LocalDb = typeof localDb;

/**
 * Checkpoint the WAL into the main database and close the connection.
 * Called on host-app quit so the DB is left clean (WAL truncated) instead of
 * accumulating an unbounded WAL across the process lifetime. Best-effort and
 * idempotent — safe to call once during the graceful-shutdown sequence.
 */
export function closeLocalDb(): void {
	if (!sqlite.open) return;
	try {
		sqlite.pragma("wal_checkpoint(TRUNCATE)");
	} catch (error) {
		console.warn("[local-db] WAL checkpoint on close failed:", error);
	}
	try {
		sqlite.close();
	} catch (error) {
		console.warn("[local-db] close failed:", error);
	}
}
