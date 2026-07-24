import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ADE_SENSITIVE_FILE_MODE,
	ensureADEHomeDir,
} from "./environment";

const TOKEN_FILE = "token";

export interface TokenInfo {
	token: string;
	/** True when this call minted a fresh token (first run). */
	minted: boolean;
	path: string;
}

/**
 * Single bearer token for the single-user server (D7). Minted once to
 * ~/.ade/token; every HTTP request and WebSocket upgrade must present it.
 */
export function loadOrMintToken(): TokenInfo {
	const home = ensureADEHomeDir();
	const path = join(home, TOKEN_FILE);
	if (existsSync(path)) {
		const token = readFileSync(path, "utf8").trim();
		if (token.length >= 32) return { token, minted: false, path };
	}
	const token = randomBytes(32).toString("hex");
	writeFileSync(path, `${token}\n`, { mode: ADE_SENSITIVE_FILE_MODE });
	try {
		chmodSync(path, ADE_SENSITIVE_FILE_MODE);
	} catch {
		// Windows: best-effort; the file inherits the user-only home dir ACL.
	}
	return { token, minted: true, path };
}

/**
 * Rotate the bearer token: mint a fresh one, overwrite ~/.ade/token, and
 * return it. Any device holding the old token is immediately locked out and
 * must re-enter the new one.
 */
export function rotateToken(): TokenInfo {
	const home = ensureADEHomeDir();
	const path = join(home, TOKEN_FILE);
	const token = randomBytes(32).toString("hex");
	writeFileSync(path, `${token}\n`, { mode: ADE_SENSITIVE_FILE_MODE });
	try {
		chmodSync(path, ADE_SENSITIVE_FILE_MODE);
	} catch {
		// Windows: best-effort; user-only home dir ACL is the boundary.
	}
	return { token, minted: true, path };
}

export function verifyToken(expected: string, presented: string | undefined) {
	if (!presented) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** Extract a bearer token from an Authorization header or a `token` query param. */
export function extractToken(
	authorizationHeader: string | undefined,
	url: string | undefined,
): string | undefined {
	if (authorizationHeader?.startsWith("Bearer ")) {
		return authorizationHeader.slice("Bearer ".length).trim();
	}
	if (url) {
		const q = url.indexOf("?");
		if (q !== -1) {
			const params = new URLSearchParams(url.slice(q));
			const t = params.get("token");
			if (t) return t;
		}
	}
	return undefined;
}
