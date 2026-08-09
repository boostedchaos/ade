import { spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname } from "node:path";

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
	// mode 0o600 is a no-op on Windows; the ACL below does the real work there.
	writeFileSync(tokenPath, token, { mode: 0o600 });
	if (process.platform === "win32") hardenTokenFileAcl(tokenPath);
	return token;
}

/** Outcome of an ACL-hardening attempt, so callers/tests can observe it
 * instead of trusting a swallowed best-effort catch. */
export type HardenResult = { applied: boolean; reason?: string };

/**
 * Restrict the token file's ACL to the current user only (Windows).
 *
 * ~/.ade normally inherits the user-profile ACL (user + Admins + SYSTEM), but
 * environments can inject extra ACEs — e.g. this box carries an inherited
 * `CodexSandboxUsers:(RX)` ACE on ~/.ade, which would let that group READ
 * control.token and drive the whole app. `/inheritance:r` strips every
 * inherited ACE and `/grant:r "<user>:F"` leaves exactly one explicit grant,
 * so even a read-widening ACE on the directory does not reach the token.
 *
 * Ceiling: this hardens the FILE only. The listener pipe keeps its default
 * DACL (Everyone read-only, no write — see socket-path.ts / the listen sites),
 * which is the real command-injection boundary; the token is the auth layer on
 * top. TOCTOU between writeFileSync and icacls is accepted: the directory ACL
 * already gates who can open a handle at creation time, so the sub-millisecond
 * window exposes nothing the directory didn't already permit.
 *
 * Best-effort: on any icacls failure we warn and continue. Bricking startup
 * over an ACL tweak is worse than the residual read-only exposure, which the
 * pipe's no-write DACL and the 32-byte token entropy still cover. The outcome
 * is RETURNED (not just warned) so tests can assert hardening actually applied
 * rather than passing vacuously when the catch swallowed a no-op.
 */
export function hardenTokenFileAcl(tokenPath: string): HardenResult {
	const user = currentWindowsUser();
	if (!user) {
		const reason = "could not resolve current Windows user";
		console.warn(
			`[control-token] ${reason}; skipping ACL hardening for ${tokenPath} ` +
				`(token entropy + pipe read-only DACL still apply).`,
		);
		return { applied: false, reason };
	}
	// spawnSync with an args array + shell:false: no shell quoting, so a
	// username with spaces is passed intact as a single argv element.
	const result = spawnSync(
		"icacls",
		[tokenPath, "/inheritance:r", "/grant:r", `${user}:F`],
		{ shell: false, encoding: "utf-8", windowsHide: true },
	);
	if (result.status !== 0) {
		const reason = `icacls exited ${result.status ?? "n/a"} for user "${user}": ${result.stderr?.trim() || result.error?.message || "unknown"}`;
		console.warn(
			`[control-token] hardening failed for ${tokenPath} (${reason}); ` +
				`token entropy + pipe read-only DACL still apply.`,
		);
		return { applied: false, reason };
	}
	return { applied: true };
}

/**
 * The current Windows account name, for icacls. `whoami` is the PRIMARY source:
 * it prints the exact `MACHINE\user` (or `DOMAIN\user`) principal the process
 * runs as, which icacls always accepts — critical on CI runners where the
 * account is domain/machine-qualified and a bare SAM name may not resolve. It
 * runs fine under bun via spawnSync (unlike `os.userInfo().username`, which bun
 * returns as the literal "unknown" on Windows without populating %USERNAME%).
 * Falls back to userInfo → %USERNAME% → %USERPROFILE% basename if whoami is
 * somehow unavailable; a bad resolution only downgrades to a logged warning
 * (hardening reports applied:false), never a security hole. Exported so the ACL
 * test asserts against the same identity.
 */
export function currentWindowsUser(): string | null {
	const fromWhoami = spawnSync("whoami", [], {
		shell: false,
		encoding: "utf-8",
		windowsHide: true,
	});
	if (fromWhoami.status === 0) {
		const name = fromWhoami.stdout?.trim();
		if (name) return name;
	}
	const fromUserInfo = userInfo().username;
	if (fromUserInfo && fromUserInfo !== "unknown") return fromUserInfo;
	if (process.env.USERNAME) return process.env.USERNAME;
	if (process.env.USERPROFILE) return basename(process.env.USERPROFILE);
	return null;
}

export function readControlToken(tokenPath: string): string {
	return readFileSync(tokenPath, "utf-8").trim();
}

/**
 * Constant-time token comparison.
 *
 * The daemon uses a plain `===`, which is acceptable there only because its
 * socket is owner-restricted on POSIX. On Windows the named pipe's default
 * DACL grants Everyone READ-ONLY (no write — a local user cannot inject
 * commands, only observe; see socket-path.ts). The token is this socket's
 * command-auth layer, and its file is ACL-hardened at write (writeControlToken
 * above). Since a reader could still capture the token off the pipe, closing
 * the comparison timing side channel is worth it.
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
