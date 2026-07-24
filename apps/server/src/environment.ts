import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ADE_HOME_DIR_ENV = "ADE_HOME_DIR";

/**
 * ADE home dir for the headless server. Mirrors the desktop app's
 * app-environment.ts resolution (same env var, same default) so the server
 * and the Electron app share one data dir. Kept dependency-free until the
 * shared module moves into packages/server-core (Phase 1 extraction).
 */
export function getADEHomeDir(): string {
	return process.env[ADE_HOME_DIR_ENV] || join(homedir(), ".ade");
}

export const ADE_HOME_DIR_MODE = 0o700;
export const ADE_SENSITIVE_FILE_MODE = 0o600;

export function ensureADEHomeDir(): string {
	const dir = getADEHomeDir();
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: ADE_HOME_DIR_MODE });
	}
	// Best-effort on Windows: chmod maps poorly to ACLs but must not crash.
	try {
		chmodSync(dir, ADE_HOME_DIR_MODE);
	} catch {
		// noop
	}
	return dir;
}
