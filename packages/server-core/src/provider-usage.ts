import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Provider usage collector (issue #35): surfaces subscription/credit usage
 * for the providers ADE drives — Anthropic (Claude Code OAuth session +
 * weekly rate-limit windows, the same numbers `claude /usage` shows) and
 * OpenRouter credits. Polled by the TopBar resource monitor.
 *
 * The Anthropic side reads the Claude Code credential file on the machine
 * running the server and calls the OAuth usage endpoint with that token.
 * macOS stores the token in the Keychain rather than the file — there the
 * Claude section is simply absent. Expired tokens are refreshed via the
 * standard OAuth refresh flow (Claude Code's public client id) and the
 * rotated tokens are written back to the credential file so Claude Code and
 * ADE stay on the same credentials.
 */

export interface UsageWindow {
	/** Percent of the rate-limit window consumed, 0–100. */
	utilization: number;
	/** ISO timestamp when the window resets, if reported. */
	resetsAt: string | null;
}

export interface ProviderUsageSnapshot {
	claude: {
		fiveHour: UsageWindow | null;
		sevenDay: UsageWindow | null;
	} | null;
	openrouter: {
		totalCredits: number;
		totalUsage: number;
	} | null;
}

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
/** Claude Code's public OAuth client id (same one the CLI itself uses). */
const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

let cached: {
	at: number;
	promise: Promise<ProviderUsageSnapshot>;
} | null = null;

/** Defensive parse of one rate-limit window from the OAuth usage response. */
export function parseUsageWindow(value: unknown): UsageWindow | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.utilization !== "number") return null;
	return {
		utilization: v.utilization,
		resetsAt: typeof v.resets_at === "string" ? v.resets_at : null,
	};
}

interface ClaudeOauthCreds {
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
}

/** Read the Claude Code credential file; null when absent/malformed. */
function readClaudeCreds(): {
	file: Record<string, unknown>;
	oauth: ClaudeOauthCreds;
} | null {
	try {
		const file = JSON.parse(readFileSync(CLAUDE_CREDENTIALS_PATH, "utf8"));
		const oauth = file?.claudeAiOauth;
		if (typeof oauth !== "object" || oauth === null) return null;
		return { file, oauth: oauth as ClaudeOauthCreds };
	} catch {
		return null; // no Claude Code credentials on this machine
	}
}

/**
 * Refresh the Claude OAuth token and write the rotated credentials back to
 * the file (refresh tokens are single-use — keeping the old one on disk
 * would strand Claude Code). Returns the fresh access token, or null.
 */
async function refreshClaudeToken(): Promise<string | null> {
	const creds = readClaudeCreds();
	const refreshToken = creds?.oauth.refreshToken;
	if (!creds || !refreshToken) return null;

	try {
		const res = await fetch(CLAUDE_TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLAUDE_OAUTH_CLIENT_ID,
			}),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (!body.access_token) return null;

		creds.file.claudeAiOauth = {
			...creds.oauth,
			accessToken: body.access_token,
			refreshToken: body.refresh_token ?? refreshToken,
			expiresAt: body.expires_in
				? Date.now() + body.expires_in * 1000
				: creds.oauth.expiresAt,
		};
		try {
			writeFileSync(
				CLAUDE_CREDENTIALS_PATH,
				JSON.stringify(creds.file, null, 2),
			);
		} catch {
			// Write-back failed (locked/read-only) — still usable this round.
		}
		return body.access_token;
	} catch {
		return null;
	}
}

function requestClaudeUsage(token: string): Promise<Response> {
	return fetch(CLAUDE_USAGE_ENDPOINT, {
		headers: {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
}

async function fetchClaudeUsage(): Promise<ProviderUsageSnapshot["claude"]> {
	const creds = readClaudeCreds();
	let token = creds?.oauth.accessToken;
	if (!creds || !token) return null;

	// Refresh proactively when the stored token is expired or about to be.
	if (
		typeof creds.oauth.expiresAt === "number" &&
		creds.oauth.expiresAt <= Date.now() + 60_000
	) {
		token = (await refreshClaudeToken()) ?? token;
	}

	try {
		let res = await requestClaudeUsage(token);
		if (res.status === 401) {
			// Stale token despite the expiry check — refresh once and retry.
			const refreshed = await refreshClaudeToken();
			if (!refreshed) return null;
			res = await requestClaudeUsage(refreshed);
		}
		if (!res.ok) return null;
		const body = (await res.json()) as Record<string, unknown>;
		const fiveHour = parseUsageWindow(body.five_hour);
		const sevenDay = parseUsageWindow(body.seven_day);
		if (!fiveHour && !sevenDay) return null;
		return { fiveHour, sevenDay };
	} catch {
		return null;
	}
}

async function fetchOpenRouterUsage(): Promise<
	ProviderUsageSnapshot["openrouter"]
> {
	// Lazy import: provider-keys pulls in local-db (better-sqlite3), which
	// must not load at module-import time (bun test can't dlopen it).
	const { getProviderKey } = await import("./provider-keys");
	const key = getProviderKey("openrouter");
	if (!key) return null;

	try {
		const res = await fetch("https://openrouter.ai/api/v1/credits", {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as {
			data?: { total_credits?: number; total_usage?: number };
		};
		if (
			typeof body.data?.total_credits !== "number" ||
			typeof body.data?.total_usage !== "number"
		) {
			return null;
		}
		return {
			totalCredits: body.data.total_credits,
			totalUsage: body.data.total_usage,
		};
	} catch {
		return null;
	}
}

/**
 * Collect provider usage. Cached (promise-level) for 60s so UI polling never
 * hammers the provider endpoints; each provider degrades to null on any
 * failure rather than erroring the whole snapshot.
 */
export function collectProviderUsage(): Promise<ProviderUsageSnapshot> {
	const now = Date.now();
	if (cached && now - cached.at < CACHE_TTL_MS) return cached.promise;

	const promise = Promise.all([fetchClaudeUsage(), fetchOpenRouterUsage()]).then(
		([claude, openrouter]) => ({ claude, openrouter }),
	);
	cached = { at: now, promise };
	return promise;
}
