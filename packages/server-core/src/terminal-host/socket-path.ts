import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { SUPERSET_DIR_NAME } from "../constants";

/**
 * Terminal-host IPC endpoint (D6).
 *
 * posix: unix socket at ~/.ade[-<ws>]/terminal-host.sock, created inside a
 * 0700 owner-only dir and chmod'ed to 0600 after listen (see daemon startup).
 * A unix domain socket is never bound to a TCP port, so it is not
 * network-reachable; the 0700 dir + 0600 socket keep it owner-only.
 *
 * win32: named pipe \\.\pipe\ade[-<ws>]-terminal-host-<user>. The pipe name
 * embeds the user, but SECURITY NOTE: the pipe's DACL is libuv's default, which
 * grants FILE_GENERIC_READ to Everyone (WD) and Anonymous (AN) — it is NOT
 * per-user ACL'd, and Node's `net` server API exposes no way to tighten it.
 * The actual access boundary is therefore the application-layer auth token: the
 * daemon's `hello` handshake requires the token from ~/.ade/*.token (mode
 * 0600, owner-only), and every data-bearing handler rejects unauthenticated
 * clients (NOT_AUTHENTICATED) — so a reader that opens the pipe via the
 * permissive DACL cannot obtain any session data without the token. Pipes have
 * no filesystem file, so they cannot be chmod'ed or unlinked (the chmod/remove
 * helpers below no-op for them) and they vanish when the server closes.
 * existsSync DOES work against the \\.\pipe\ namespace, so liveness probes stay
 * uniform.
 */
export function getTerminalHostSocketPath(): string {
	return getTerminalHostSocketPathFor(SUPERSET_DIR_NAME);
}

/** Parameterized variant so tests can target an isolated data dir. */
export function getTerminalHostSocketPathFor(dirName: string): string {
	if (process.platform === "win32") {
		let rawUser = "";
		try {
			rawUser = userInfo().username;
		} catch {
			rawUser = process.env.USERNAME || process.env.USER || "user";
		}
		const user = rawUser.replace(/[^A-Za-z0-9-]/g, "-") || "user";
		const base = dirName.replace(/^\./, "");
		return `\\\\.\\pipe\\${base}-terminal-host-${user}`;
	}
	return join(homedir(), dirName, "terminal-host.sock");
}

export function isNamedPipePath(socketPath: string): boolean {
	return socketPath.startsWith("\\\\.\\pipe\\");
}

/** Remove a stale socket file. No-op for named pipes (nothing to unlink). */
export function removeSocketFile(socketPath: string): void {
	if (isNamedPipePath(socketPath)) return;
	try {
		if (existsSync(socketPath)) unlinkSync(socketPath);
	} catch {
		// best-effort
	}
}

/** Restrict socket access to the owner. No-op for named pipes (ACL'd per user). */
export function chmodSocketFile(socketPath: string, mode = 0o600): void {
	if (isNamedPipePath(socketPath)) return;
	try {
		chmodSync(socketPath, mode);
	} catch {
		// best-effort
	}
}
