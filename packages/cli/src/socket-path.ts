/**
 * Control-plane endpoint paths.
 *
 * Mirrors packages/server-core/src/terminal-host/socket-path.ts conventions
 * (PROTOCOL.md "Transport"), but is deliberately dependency-free: the CLI is a
 * standalone bin that must start fast and must not pull Electron/server-core
 * into its module graph. The derivation of the data-dir name is a copy of
 * server-core's `getWorkspaceName()` + `SUPERSET_DIR_NAME` — keep them in sync.
 *
 * posix: ~/.ade[-<ws>]/control.sock   win32: \\.\pipe\ade[-<ws>]-control-<user>
 */
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/** server-core env.shared.ts: default "superset" means "no suffix". */
export function getWorkspaceSuffix(
	workspaceName = process.env.SUPERSET_WORKSPACE_NAME,
): string | undefined {
	const name = workspaceName ?? "superset";
	if (name === "superset") return undefined;
	return name
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.slice(0, 32);
}

/** e.g. ".ade" or ".ade-tcli". */
export function getAdeDirName(
	workspaceName = process.env.SUPERSET_WORKSPACE_NAME,
): string {
	const suffix = getWorkspaceSuffix(workspaceName);
	return suffix ? `.ade-${suffix}` : ".ade";
}

export function isNamedPipePath(socketPath: string): boolean {
	return socketPath.startsWith("\\\\.\\pipe\\");
}

export function getControlSocketPathFor(
	dirName: string,
	home = homedir(),
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === "win32") {
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
	return join(home, dirName, "control.sock");
}

export function getControlTokenPathFor(
	dirName: string,
	home = homedir(),
): string {
	return join(home, dirName, "control.token");
}

export function getControlSocketPath(): string {
	return getControlSocketPathFor(getAdeDirName());
}

export function getControlTokenPath(): string {
	return getControlTokenPathFor(getAdeDirName());
}
