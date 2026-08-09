import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/**
 * Control-plane IPC endpoint. Sibling of
 * packages/server-core/src/terminal-host/socket-path.ts — deliberately a copy
 * rather than a parameterisation of it, per the Phase 0 recon, so the two
 * sockets can diverge without one breaking the other.
 *
 * posix: unix socket at ~/.ade[-<ws>]/control.sock, inside the app's 0700
 * home dir and chmod'ed 0600 after listen. Never bound to a TCP port.
 *
 * win32: named pipe \\.\pipe\ade[-<ws>]-control-<user>. SECURITY NOTE
 * inherited verbatim from the terminal-host module: the pipe's DACL is
 * libuv's default and grants FILE_GENERIC_READ to Everyone and Anonymous.
 * Node's `net` server API exposes no way to tighten it, so on Windows the
 * ONLY access boundary is the application-layer token. This socket executes
 * commands with the user's full power, which is why the token check is
 * mandatory-by-construction (see auth middleware) rather than per handler.
 */
export function getControlSocketPathFor(dirName: string): string {
	if (process.platform === "win32") {
		let rawUser = "";
		try {
			rawUser = userInfo().username;
		} catch {
			rawUser = process.env.USERNAME || process.env.USER || "user";
		}
		const user = rawUser.replace(/[^A-Za-z0-9-]/g, "-") || "user";
		const base = dirName.replace(/^\./, "");
		return `\\\\.\\pipe\\${base}-control-${user}`;
	}
	return join(homedir(), dirName, "control.sock");
}

export function getControlTokenPathFor(dirName: string): string {
	return join(homedir(), dirName, "control.token");
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

/** Restrict socket access to the owner. No-op for named pipes. */
export function chmodSocketFile(socketPath: string, mode = 0o600): void {
	if (isNamedPipePath(socketPath)) return;
	try {
		chmodSync(socketPath, mode);
	} catch {
		// best-effort
	}
}
