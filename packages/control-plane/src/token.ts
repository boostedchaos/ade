import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Per-launch control token.
 *
 * DIVERGENCE FROM terminal-host, and the reason this is not a shared helper:
 * `ensureAuthToken` in daemon.ts reuses an existing token file so reconnecting
 * clients survive a daemon restart. The control token must NOT do that — a
 * socket that can drive the whole app gets a fresh secret per app launch
 * (SPEC Security constraints). Hence an UNCONDITIONAL write, never
 * `if (!existsSync)`. A CLI invocation always re-reads the file, so rotation
 * costs nothing.
 */
export function writeControlToken(tokenPath: string): string {
	mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
	const token = randomBytes(32).toString("hex");
	writeFileSync(tokenPath, token, { mode: 0o600 });
	return token;
}

export function readControlToken(tokenPath: string): string {
	return readFileSync(tokenPath, "utf-8").trim();
}

/**
 * Constant-time token comparison.
 *
 * The daemon uses a plain `===`, which is acceptable there only because its
 * socket is owner-restricted on POSIX. On Windows the named pipe's DACL is
 * permissive (see socket-path.ts) and this socket executes arbitrary
 * commands, so the timing side channel is worth closing.
 */
export function tokensMatch(expected: string, provided: unknown): boolean {
	if (typeof provided !== "string") return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(provided, "utf8");
	// timingSafeEqual throws on a length mismatch, which is itself a leak of
	// length only — acceptable, and the token length is a fixed public 64.
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
