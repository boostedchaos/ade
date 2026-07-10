/**
 * Build-time guard for native runtime dependencies.
 *
 * This fails early when:
 * 1) libsql internals are accidentally bundled into dist/main (dynamic require risk)
 * 2) required native runtime packages are missing from apps/desktop/node_modules
 */

import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
} from "node:fs";
import { join } from "node:path";

const projectRoot = join(import.meta.dirname, "..");

function fail(message: string): never {
	console.error(`[validate:native-runtime] ${message}`);
	process.exit(1);
}

function assertExists(path: string, reason: string): void {
	if (!existsSync(path)) {
		fail(`${reason}\nMissing path: ${path}`);
	}
}

function validateLibsqlNotBundled(): void {
	const sourceMapPath = join(projectRoot, "dist", "main", "index.js.map");
	assertExists(
		sourceMapPath,
		"Main bundle sourcemap not found. Run `bun run compile:app` first.",
	);

	const sourceMap = readFileSync(sourceMapPath, "utf8");
	if (sourceMap.includes("node_modules/.bun/libsql@")) {
		fail(
			[
				"Detected bundled `libsql` sources in dist/main/index.js.map.",
				"This usually causes runtime dynamic require failures in packaged apps.",
				"Ensure `libsql` stays in `rollupOptions.external` for the main process.",
			].join("\n"),
		);
	}

	const distMainDir = join(projectRoot, "dist", "main");
	assertExists(
		distMainDir,
		"Main bundle output not found. Run `bun run compile:app` first.",
	);

	const jsFiles = collectFiles(distMainDir).filter((filePath) =>
		filePath.endsWith(".js"),
	);
	for (const filePath of jsFiles) {
		const content = readFileSync(filePath, "utf8");
		const hasDynamicLibsqlRequirePattern = /@libsql\/\$\{target\}/.test(
			content,
		);
		if (
			hasDynamicLibsqlRequirePattern ||
			content.includes("commonjsRequire(`@libsql/")
		) {
			fail(
				[
					"Detected dynamic `@libsql/<platform>` require logic in bundled JS output.",
					"This indicates libsql internals were bundled instead of externalized.",
					`Offending file: ${filePath}`,
				].join("\n"),
			);
		}
	}

	console.log(
		"[validate:native-runtime] OK: libsql is externalized from main bundle",
	);
}

function collectFiles(rootDir: string): string[] {
	const entries = readdirSync(rootDir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = join(rootDir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectFiles(fullPath));
			continue;
		}
		files.push(fullPath);
	}
	return files;
}

function getPlatformLibsqlCandidates(): string[] {
	if (process.platform === "darwin") {
		return [
			process.arch === "arm64" ? "@libsql/darwin-arm64" : "@libsql/darwin-x64",
		];
	}

	if (process.platform === "linux") {
		if (process.arch === "arm64") {
			return ["@libsql/linux-arm64-gnu", "@libsql/linux-arm64-musl"];
		}
		if (process.arch === "arm") {
			return ["@libsql/linux-arm-gnueabihf", "@libsql/linux-arm-musleabihf"];
		}
		return ["@libsql/linux-x64-gnu", "@libsql/linux-x64-musl"];
	}

	if (process.platform === "win32") {
		return ["@libsql/win32-x64-msvc"];
	}

	return [];
}

function validateNativeModulesPrepared(): void {
	const nodeModulesDir = join(projectRoot, "node_modules");
	assertExists(
		nodeModulesDir,
		"node_modules not found. Run `bun install` and `bun run copy:native-modules` first.",
	);

	const requiredModules = [
		"libsql/package.json",
		"@neon-rs/load/package.json",
		"detect-libc/package.json",
	];
	for (const modulePath of requiredModules) {
		assertExists(
			join(nodeModulesDir, modulePath),
			"Required native runtime dependency is missing.",
		);
	}

	const platformCandidates = getPlatformLibsqlCandidates();
	if (platformCandidates.length === 0) {
		console.warn(
			`[validate:native-runtime] Skipping platform-specific @libsql check for ${process.platform}/${process.arch}`,
		);
		return;
	}

	const hasPlatformPackage = platformCandidates.some((pkg) =>
		existsSync(join(nodeModulesDir, pkg, "package.json")),
	);
	if (!hasPlatformPackage) {
		fail(
			[
				"Missing platform-specific @libsql package.",
				`Expected one of: ${platformCandidates.join(", ")}`,
				"Run `bun run copy:native-modules` and ensure optional dependencies are materialized.",
			].join("\n"),
		);
	}

	console.log(
		`[validate:native-runtime] OK: platform libsql package present (${platformCandidates.join(" | ")})`,
	);
}

function parseTargetPlatform(): NodeJS.Platform {
	const arg = process.argv
		.slice(2)
		.find((a) => a.startsWith("--platform="));
	if (!arg) return process.platform;
	const value = arg.slice("--platform=".length);
	return value as NodeJS.Platform;
}

/**
 * Windows cross-build guard: assert every win32-x64 native binary was staged by
 * `scripts/prepare-win-natives.ts` before electron-builder packages them. This
 * runs on macOS (or any host) so it inspects the staged `.win32-natives/` tree
 * rather than the host's node_modules.
 */
function validateWin32NativesStaged(): void {
	const stagingDir = join(projectRoot, ".win32-natives");
	assertExists(
		stagingDir,
		"Win32 natives not staged. Run `bun run scripts/prepare-win-natives.ts` first.",
	);

	const requiredBinaries = [
		// node-pty (lydell) win32 — conpty agent binaries + winpty console list
		"@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty.node",
		"@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty_console_list.node",
		"@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/conpty.dll",
		"@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/OpenConsole.exe",
		// libsql win32 native
		"@libsql/win32-x64-msvc/index.node",
		// ast-grep win32 native
		"@ast-grep/napi-win32-x64-msvc/ast-grep-napi.win32-x64-msvc.node",
		// better-sqlite3 win32 Electron prebuild (staged copy)
		"better-sqlite3/build/Release/better_sqlite3.node",
	];

	for (const relPath of requiredBinaries) {
		const filePath = join(stagingDir, relPath);
		assertExists(
			filePath,
			`Required staged win32-x64 native binary is missing: ${relPath}`,
		);
		if (!isPeBinary(filePath)) {
			fail(
				`Staged win32 binary is not a PE (Windows) file: ${filePath}\nRe-run prepare-win-natives.`,
			);
		}
	}

	console.log(
		"[validate:native-runtime] OK: all win32-x64 native binaries staged and PE-valid",
	);
}

/** A PE (Windows) executable/DLL starts with the ASCII bytes "MZ". */
function isPeBinary(filePath: string): boolean {
	if (!existsSync(filePath)) return false;
	const fd = openSync(filePath, "r");
	try {
		const buf = Buffer.alloc(2);
		const bytes = readSync(fd, buf, 0, 2, 0);
		return bytes === 2 && buf[0] === 0x4d && buf[1] === 0x5a;
	} finally {
		closeSync(fd);
	}
}

function main(): void {
	const targetPlatform = parseTargetPlatform();
	validateLibsqlNotBundled();

	if (targetPlatform === "win32" && process.platform !== "win32") {
		// Cross-build: validate staged win32 binaries instead of host node_modules.
		validateWin32NativesStaged();
		console.log("[validate:native-runtime] All checks passed (win32 target)");
		return;
	}

	validateNativeModulesPrepared();
	console.log("[validate:native-runtime] All checks passed");
}

main();
