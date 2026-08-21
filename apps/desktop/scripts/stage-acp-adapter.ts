/**
 * Stage the `claude-agent-acp` adapter tree for electron-builder.
 *
 * Three problems this solves, in order of how badly each bites:
 *
 * 1. **Size.** The adapter's dependency `@anthropic-ai/claude-agent-sdk` has an
 *    `optionalDependency` per platform that VENDORS the Claude Code CLI —
 *    `@anthropic-ai/claude-agent-sdk-darwin-arm64` alone is 246 MB. Argus does
 *    not bundle coding CLIs (README line 58) and a bundled copy would drift
 *    from the Claude Code the user actually runs, so it is omitted: the walk
 *    below follows `dependencies` ONLY, which is exactly the set that excludes
 *    every optional platform package. The adapter is then pointed at the
 *    user's own install via `CLAUDE_CODE_EXECUTABLE`
 *    (`main/lib/acp-host/claude-executable.ts`).
 *
 * 2. **Symlinks.** Bun 1.3's isolated linker fills `node_modules` with
 *    symlinks into `node_modules/.bun`, which electron-builder cannot follow.
 *    Same problem `copy:native-modules` solves for native modules, same
 *    solution: materialize real copies first.
 *
 * 3. **Silent absence.** A build that "degrades gracefully" past a missing
 *    input ships an app with a whole feature quietly gone. This script exits
 *    NON-ZERO on any failure, and verifies the adapter's spawnable entry
 *    exists in the staged tree before it returns.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGING_DIR = join(DESKTOP_DIR, ".acp-adapter", "node_modules");
const ADAPTER = "@agentclientprotocol/claude-agent-acp";
const ADAPTER_ENTRY = join(
	STAGING_DIR,
	...ADAPTER.split("/"),
	"dist",
	"index.js",
);

interface PackageJson {
	name?: string;
	dependencies?: Record<string, string>;
}

function readPackageJson(packageJsonPath: string): PackageJson {
	return JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
}

/**
 * Resolve a package's directory as seen FROM another package.
 *
 * Resolution has to start at the dependent, not at the desktop app: under the
 * isolated linker a transitive dependency is only visible from the package
 * that declares it.
 */
function resolvePackageDir(name: string, fromDir: string): string {
	const require_ = createRequire(join(fromDir, "package.json"));
	return dirname(require_.resolve(`${name}/package.json`));
}

function collect(
	name: string,
	fromDir: string,
	found: Map<string, string>,
): void {
	if (found.has(name)) return;
	const packageDir = resolvePackageDir(name, fromDir);
	found.set(name, packageDir);

	const manifest = readPackageJson(join(packageDir, "package.json"));
	// `dependencies` only — see (1) above. `optionalDependencies` is where the
	// vendored per-platform CLI lives, and `devDependencies` is build-time.
	for (const dependency of Object.keys(manifest.dependencies ?? {})) {
		collect(dependency, packageDir, found);
	}
}

function main(): void {
	const found = new Map<string, string>();
	collect(ADAPTER, DESKTOP_DIR, found);

	rmSync(join(DESKTOP_DIR, ".acp-adapter"), { recursive: true, force: true });
	mkdirSync(STAGING_DIR, { recursive: true });

	for (const [name, packageDir] of found) {
		const destination = join(STAGING_DIR, ...name.split("/"));
		mkdirSync(dirname(destination), { recursive: true });
		// `dereference` is the whole point: the source is a symlink farm.
		cpSync(packageDir, destination, { recursive: true, dereference: true });
	}

	if (!existsSync(ADAPTER_ENTRY)) {
		throw new Error(
			`stage-acp-adapter: staged tree is missing the adapter entry at ${ADAPTER_ENTRY}. ` +
				"The packaged app would have no ACP adapter at all.",
		);
	}

	console.log(
		`[stage-acp-adapter] staged ${found.size} packages into ${STAGING_DIR}`,
	);
	for (const name of [...found.keys()].sort()) {
		console.log(`[stage-acp-adapter]   ${name}`);
	}
}

main();
