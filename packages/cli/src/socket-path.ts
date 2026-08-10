/**
 * Control-plane endpoint paths.
 *
 * Mirrors packages/server-core/src/terminal-host/socket-path.ts conventions
 * (PROTOCOL.md "Transport"), but is deliberately dependency-free: the CLI is a
 * standalone bin that must start fast and must not pull Electron/server-core
 * into its module graph. `@superset/shared/constants` is a literals-only module
 * with no imports of its own, which is why the env-var name may come from
 * there rather than being spelled a second time.
 *
 * posix: ~/.ade[-<ws>]/control.sock   win32: \\.\pipe\ade[-<ws>]-control-<user>
 */
import { spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import {
	ADE_DATA_DIR_NAME_ENV,
	ADE_DATA_DIR_NAME_PATTERN,
} from "@superset/shared/constants";

/**
 * LEGACY derivation: the data-dir suffix guessed from a workspace name, as
 * server-core's env.shared.ts computes it ("superset" means "no suffix").
 *
 * Only step 2 of `getAdeDirName`'s precedence uses this. It is a guess, not an
 * answer: in an agent terminal `$SUPERSET_WORKSPACE_NAME` is the workspace's
 * display name, which matches the data-dir suffix only by coincidence.
 */
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

/**
 * The app's data-dir name, e.g. ".ade" or ".ade-default".
 *
 * Precedence, in order:
 *   1. `$ADE_DATA_DIR_NAME` verbatim, when it is a safe single path segment.
 *      The app injects this into every agent terminal, so the CLI uses the
 *      dir the running app actually owns.
 *   2. The legacy derivation from `$SUPERSET_WORKSPACE_NAME`. That variable
 *      carries the workspace's DISPLAY name in agent terminals, so this path
 *      guesses wrong inside any named workspace — it survives only for
 *      external shells started before this change.
 *   3. ".ade".
 *
 * Accepts either a full env object (preferred) or a bare workspace-name string
 * for the pre-existing string call sites.
 */
export function getAdeDirName(
	env: NodeJS.ProcessEnv | string | undefined = process.env,
): string {
	const explicit = resolveExplicitDirName(env);
	if (explicit) return explicit;
	// `?? "superset"` rather than passing undefined through: undefined would
	// trigger getWorkspaceSuffix's own process.env default, so an explicitly
	// supplied env bag with no workspace name would silently pick up the
	// AMBIENT one instead of resolving to ".ade".
	const suffix = getWorkspaceSuffix(readWorkspaceName(env) ?? "superset");
	return suffix ? `.ade-${suffix}` : ".ade";
}

/** A bare string argument is a workspace name, not an env bag. */
function readWorkspaceName(
	env: NodeJS.ProcessEnv | string | undefined,
): string | undefined {
	if (typeof env === "string") return env;
	return env?.SUPERSET_WORKSPACE_NAME;
}

/**
 * `$ADE_DATA_DIR_NAME` when present AND safe. The value becomes a path segment
 * directly under the home dir, so a value carrying a separator or a traversal
 * is rejected outright rather than sanitised — a rejected value falls through
 * to the legacy derivation, which can only ever produce a safe name.
 */
function resolveExplicitDirName(
	env: NodeJS.ProcessEnv | string | undefined,
): string | undefined {
	if (typeof env === "string" || env === undefined) return undefined;
	const raw = env[ADE_DATA_DIR_NAME_ENV];
	if (!raw) return undefined;
	return ADE_DATA_DIR_NAME_PATTERN.test(raw) ? raw : undefined;
}

export function isNamedPipePath(socketPath: string): boolean {
	return socketPath.startsWith("\\\\.\\pipe\\");
}

/**
 * Same sanitisation the app applies before it names the pipe
 * (packages/control-plane/src/socket-path.ts). Both sides must agree
 * character-for-character or the CLI dials a pipe nobody listens on.
 */
function sanitizeUser(raw: string | undefined): string | undefined {
	return raw?.trim().replace(/[^A-Za-z0-9-]/g, "-") || undefined;
}

let cachedWhoami: string | null | undefined;

/**
 * Raw first line of `whoami` — `DOMAIN\user` on Windows, `user` on posix. Cached
 * for the process: the answer cannot change, and the CLI must stay fast.
 */
function whoamiUser(): string | undefined {
	if (cachedWhoami === undefined) {
		cachedWhoami = null;
		try {
			const result = spawnSync("whoami", {
				encoding: "utf8",
				shell: false,
				windowsHide: true,
			});
			cachedWhoami = (result.stdout ?? "").trim().split(/\r?\n/)[0] || null;
		} catch {
			// no whoami on PATH — the next fallback answers
		}
	}
	return cachedWhoami ?? undefined;
}

/**
 * THE BUG this chain exists for: ADE's own agent terminals carry neither
 * USERNAME nor USER, and under **bun** `os.userInfo().username` then returns the
 * literal string "unknown" instead of throwing — so the old try/catch fallbacks
 * never fired and every `ade` call in an agent pane dialled
 * `\\.\pipe\ade-control-unknown` while the app listened on `…-control-<user>`.
 *
 * "unknown" is rejected at every step that can carry the sentinel forward: any
 * bun-hosted process that injects its own resolved name into a child's
 * USERNAME/USER would otherwise re-create the bug AND suppress the whoami
 * fallback. `whoami` is authoritative, so a real account named "unknown" is
 * still answered there.
 * Steps are thunks so `whoami` is spawned only when the cheap ones came up empty.
 */
const SENTINEL_USER = "unknown";

/** Drops bun's "unknown" sentinel and blank values. */
function rejectSentinel(name: string | undefined): string | undefined {
	const trimmed = name?.trim();
	return !trimmed || trimmed.toLowerCase() === SENTINEL_USER
		? undefined
		: trimmed;
}

export function getUserName(deps?: {
	userInfoUser?: () => string;
	env?: NodeJS.ProcessEnv;
	whoami?: () => string | undefined;
}): string {
	const env = deps?.env ?? process.env;
	const readUserInfo = deps?.userInfoUser ?? (() => userInfo().username);
	const whoami = deps?.whoami ?? whoamiUser;
	const steps: Array<() => string | undefined> = [
		() => rejectSentinel(readUserInfo()),
		() => rejectSentinel(env.USERNAME),
		() => rejectSentinel(env.USER),
		// `DOMAIN\user` → `user`; a bare name is unchanged.
		() => whoami()?.split("\\").pop(),
		() => (env.USERPROFILE ? basename(env.USERPROFILE) : undefined),
	];
	for (const step of steps) {
		let value: string | undefined;
		try {
			value = sanitizeUser(step());
		} catch {
			value = undefined;
		}
		if (value) return value;
	}
	return "user";
}

export function getControlSocketPathFor(
	dirName: string,
	home = homedir(),
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === "win32") {
		const user = getUserName();
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
