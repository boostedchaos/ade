import type { IncomingMessage } from "node:http";

/**
 * Failed-auth rate limiter (PHASE_4 security pass). Single-user server, so
 * this is a backstop against token brute-forcing over an exposed reverse
 * proxy, not a multi-tenant defense. Fixed window per client IP: after
 * MAX_FAILURES bad attempts, lock that IP out for LOCKOUT_MS. Any success
 * clears the IP's counter.
 */

const MAX_FAILURES = 10;
const LOCKOUT_MS = 60_000;

interface Bucket {
	failures: number;
	lockedUntil: number;
}

const buckets = new Map<string, Bucket>();

function clientIp(req: IncomingMessage): string {
	// Behind Tailscale/Caddy the socket peer is the proxy; prefer the
	// forwarded client when present (trusted because the only front ends we
	// document are Tailscale and a local Caddy).
	const fwd = req.headers["x-forwarded-for"];
	if (typeof fwd === "string" && fwd.length > 0) {
		return fwd.split(",")[0]?.trim() ?? "unknown";
	}
	return req.socket.remoteAddress ?? "unknown";
}

/** True if this IP is currently locked out (call before verifying the token). */
export function isLockedOut(req: IncomingMessage, now = Date.now()): boolean {
	const b = buckets.get(clientIp(req));
	if (!b) return false;
	if (b.lockedUntil > now) return true;
	if (b.lockedUntil !== 0 && b.lockedUntil <= now) {
		// Lockout expired — reset.
		buckets.delete(clientIp(req));
	}
	return false;
}

/** Record the outcome of an auth attempt so the window advances. */
export function recordAuthResult(
	req: IncomingMessage,
	ok: boolean,
	now = Date.now(),
): void {
	const ip = clientIp(req);
	if (ok) {
		buckets.delete(ip);
		return;
	}
	const b = buckets.get(ip) ?? { failures: 0, lockedUntil: 0 };
	b.failures += 1;
	if (b.failures >= MAX_FAILURES) {
		b.lockedUntil = now + LOCKOUT_MS;
		b.failures = 0;
	}
	buckets.set(ip, b);
}

/** Test/introspection helper. */
export function _resetRateLimit(): void {
	buckets.clear();
}
