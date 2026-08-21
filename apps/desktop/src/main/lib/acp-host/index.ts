/**
 * Desktop shim for `@ade/server-core/acp-host` (Phase 2, D2).
 *
 * Exactly the terminal-host shim's shape (`main/lib/terminal-host/client.ts`):
 * registration runs at MODULE TOP LEVEL and every desktop consumer imports the
 * host through this path, so "a pane was created before the resolver was
 * registered" is impossible by construction rather than by ordering luck.
 *
 * Two Electron-specific facts live here and nowhere else:
 *
 * - WHERE the adapter script is (dev tree vs `process.resourcesPath`).
 * - WHICH Claude Code the adapter drives. Phase 2 does not bundle one
 *   (see `claude-executable.ts`), so the child env carries
 *   `CLAUDE_CODE_EXECUTABLE` pointing at the user's install.
 *
 * The exec path deliberately registers NO resolver: `process.execPath` in the
 * desktop main process is the Electron binary, and `spawnAcpChildEnv()` already
 * adds `ELECTRON_RUN_AS_NODE=1` for exactly that case — which is what Phase 1's
 * seam was built for. Registering `"node"` here would depend on the user's PATH
 * for no benefit.
 */

import { join } from "node:path";
import { acpError, setAcpBinaryPathResolver } from "@ade/server-core/acp-host";
import { app } from "electron";
import {
	claudeNotFoundMessage,
	defaultClaudeLookupIo,
	findClaudeExecutable,
} from "./claude-executable";

/**
 * Absolute path to the adapter's spawnable entry.
 *
 * `dist/index.js` (the package's `bin`), NOT the package `main` — `main` is
 * `dist/lib.js`, the library. Both branches are a filesystem join rather than
 * a module resolution: the main bundle is CJS, so `import.meta.url` is not
 * available for `createRequire`, and `app.getAppPath()` is the same anchor the
 * terminal-host shim uses.
 *
 * Packaged builds read it from `extraResources` rather than the asar, so the
 * child script and every `require` it makes are plain files that Node's normal
 * sibling resolution finds — no asar patching, no `asarUnpack`.
 */
export function resolveAcpAdapterEntry(): string {
	if (app.isPackaged) {
		return join(
			process.resourcesPath,
			"node_modules",
			"@agentclientprotocol",
			"claude-agent-acp",
			"dist",
			"index.js",
		);
	}
	return join(
		app.getAppPath(),
		"node_modules",
		"@agentclientprotocol",
		"claude-agent-acp",
		"dist",
		"index.js",
	);
}

setAcpBinaryPathResolver(resolveAcpAdapterEntry);

/**
 * Environment additions for an ACP child.
 *
 * Throws `acp-claude-not-found` BEFORE the spawn when no Claude Code exists on
 * the machine. That ordering is the whole point: the adapter's own failure for
 * a missing CLI is a startup hang followed by a 15 s timeout, and the pane
 * would show neither the cause nor the fix.
 */
export function acpChildEnv(): Record<string, string> {
	const io = defaultClaudeLookupIo();
	const found = findClaudeExecutable(io);
	if (!found) {
		throw acpError("acp-claude-not-found", claudeNotFoundMessage(io.override));
	}
	return { CLAUDE_CODE_EXECUTABLE: found.path };
}

export * from "@ade/server-core/acp-host";
