/**
 * Stage win32-x64 native binaries for a cross-platform Windows build.
 *
 * This runs on the developer's Mac (or a CI runner of any OS) and fetches the
 * prebuilt Windows binaries WITHOUT compiling anything. The staged artifacts
 * land in `apps/desktop/.win32-natives/` (a sibling of node_modules so
 * electron-builder never mistakes it for a real package tree). The Windows
 * electron-builder config (`electron-builder.win.ts`) maps each staged package
 * to its final `node_modules/<name>` location inside the packaged app.
 *
 * Critically, better-sqlite3 is staged as a full COPY with the win32 binary
 * swapped in, so the darwin binary the macOS build needs is never clobbered.
 * The other packages are separate platform-specific package names, so they are
 * simply fetched alongside.
 *
 * Every fetched `.node`/DLL is verified to be a real PE (Windows) binary; the
 * script fails loudly if anything is missing or has the wrong format.
 */

import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	closeSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const appDesktopDir = dirname(import.meta.dirname);
const nodeModulesDir = join(appDesktopDir, "node_modules");
const stagingDir = join(appDesktopDir, ".win32-natives");

function fail(message: string): never {
	console.error(`[prepare-win-natives] ${message}`);
	process.exit(1);
}

/** Read the resolved `version` from a package.json, failing loudly if absent. */
function readResolvedVersion(pkgJsonRelPath: string): string {
	const pkgJsonPath = join(nodeModulesDir, pkgJsonRelPath, "package.json");
	if (!existsSync(pkgJsonPath)) {
		fail(
			`Cannot resolve version: ${pkgJsonPath} not found. Run copy:native-modules / bun install first.`,
		);
	}
	const version = (
		JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { version?: string }
	).version;
	if (!version) fail(`No version field in ${pkgJsonPath}`);
	return version;
}

// ---------------------------------------------------------------------------
// Versions are DERIVED from the resolved packages in node_modules (not
// hardcoded), so a lockfile/package.json bump can never silently mismatch the
// wrapper and its win32 binary package. The win32 binary package version must
// equal the host/wrapper version:
//   - node-pty is aliased to @lydell/node-pty; its resolved version drives
//     @lydell/node-pty-win32-x64.
//   - libsql / @ast-grep/napi wrappers drive their -win32-x64-msvc binaries.
// The Electron target (for the better-sqlite3 prebuild ABI) is read from the
// electron devDependency so it tracks the electron bump automatically.
// ---------------------------------------------------------------------------
const LYDELL_VERSION = readResolvedVersion("node-pty");
const LIBSQL_WIN_VERSION = readResolvedVersion("libsql");
const ASTGREP_WIN_VERSION = readResolvedVersion(join("@ast-grep", "napi"));
const ELECTRON_TARGET = (() => {
	const pkg = JSON.parse(
		readFileSync(join(appDesktopDir, "package.json"), "utf8"),
	) as { devDependencies?: Record<string, string> };
	const raw = pkg.devDependencies?.electron;
	if (!raw) fail("electron devDependency not found in apps/desktop/package.json");
	return raw.replace(/^[\^~]/, "");
})();

const NPM_WIN_PACKAGES = [
	`@lydell/node-pty-win32-x64@${LYDELL_VERSION}`,
	`@libsql/win32-x64-msvc@${LIBSQL_WIN_VERSION}`,
	`@ast-grep/napi-win32-x64-msvc@${ASTGREP_WIN_VERSION}`,
];

// Package name → the file inside it that must exist and be a valid PE binary.
const REQUIRED_PE_BINARIES: Record<string, string> = {
	"@lydell/node-pty-win32-x64": "prebuilds/win32-x64/conpty.node",
	"@libsql/win32-x64-msvc": "index.node",
	"@ast-grep/napi-win32-x64-msvc": "ast-grep-napi.win32-x64-msvc.node",
};

/** A PE (Windows) executable/DLL starts with the ASCII bytes "MZ" (0x4D 0x5A). */
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

function stageNpmWinPackages(): void {
	console.log(
		"[prepare-win-natives] Fetching win32-x64 npm packages (no compile)...",
	);
	const npmTmp = mkdtempSync(join(tmpdir(), "ade-win-natives-"));
	try {
		// npm needs a project root to install into; an empty package.json in an
		// isolated tmp dir keeps it away from the Bun workspace tree entirely.
		writeFileSync(
			join(npmTmp, "package.json"),
			JSON.stringify({ name: "ade-win-natives-stage", private: true }),
		);

		// npm >= 10 honours --os/--cpu to fetch foreign-platform packages.
		// --force overrides the host os/cpu compatibility guard.
		execFileSync(
			"npm",
			[
				"install",
				"--no-save",
				"--force",
				"--os=win32",
				"--cpu=x64",
				"--no-audit",
				"--no-fund",
				...NPM_WIN_PACKAGES,
			],
			{ cwd: npmTmp, stdio: "inherit" },
		);

		const tmpNodeModules = join(npmTmp, "node_modules");
		for (const spec of NPM_WIN_PACKAGES) {
			const name = spec.slice(0, spec.lastIndexOf("@"));
			const src = join(tmpNodeModules, name);
			if (!existsSync(src)) {
				fail(`npm did not install ${name} (expected at ${src})`);
			}
			const dest = join(stagingDir, name);
			mkdirSync(dirname(dest), { recursive: true });
			cpSync(src, dest, { recursive: true, dereference: true });
			console.log(`  staged ${name}`);
		}
	} finally {
		rmSync(npmTmp, { recursive: true, force: true });
	}
}

function stageBetterSqlite3(): void {
	console.log(
		"[prepare-win-natives] Staging better-sqlite3 win32-x64 (electron ABI target)...",
	);
	const realBetterSqlite = join(nodeModulesDir, "better-sqlite3");
	if (!existsSync(join(realBetterSqlite, "package.json"))) {
		fail(
			`better-sqlite3 not materialized at ${realBetterSqlite}. Run copy:native-modules first.`,
		);
	}

	// Full copy so the real (darwin) binary the macOS build uses is untouched.
	const stagedBetterSqlite = join(stagingDir, "better-sqlite3");
	cpSync(realBetterSqlite, stagedBetterSqlite, {
		recursive: true,
		dereference: true,
	});

	// Overwrite ONLY the staged copy's binary with the win32-x64 Electron prebuild.
	const prebuildInstallBin = require.resolve("prebuild-install/bin.js", {
		paths: [nodeModulesDir],
	});
	execFileSync(
		process.execPath,
		[
			prebuildInstallBin,
			"--platform=win32",
			"--arch=x64",
			"--runtime=electron",
			`--target=${ELECTRON_TARGET}`,
			"--tag-prefix=v",
		],
		{ cwd: stagedBetterSqlite, stdio: "inherit" },
	);

	const stagedBinary = join(
		stagedBetterSqlite,
		"build",
		"Release",
		"better_sqlite3.node",
	);
	if (!isPeBinary(stagedBinary)) {
		fail(
			`better-sqlite3 win32 binary missing or not a PE file: ${stagedBinary}`,
		);
	}
	console.log(`  staged better-sqlite3 win32 binary: ${stagedBinary}`);
}

function verifyStagedBinaries(): void {
	console.log("[prepare-win-natives] Verifying PE headers...");
	for (const [name, relPath] of Object.entries(REQUIRED_PE_BINARIES)) {
		const filePath = join(stagingDir, name, relPath);
		if (!isPeBinary(filePath)) {
			fail(`Expected PE binary missing/invalid: ${filePath}`);
		}
		console.log(`  OK (PE x64): ${name}/${relPath}`);
	}
	// node-pty win32 also ships conpty DLL + OpenConsole helper — assert present.
	const conptyDll = join(
		stagingDir,
		"@lydell/node-pty-win32-x64",
		"prebuilds/win32-x64/conpty/conpty.dll",
	);
	if (!isPeBinary(conptyDll)) {
		fail(`node-pty win32 conpty.dll missing/invalid: ${conptyDll}`);
	}
	console.log("  OK (PE x64): @lydell/node-pty-win32-x64/.../conpty/conpty.dll");
}

function main(): void {
	console.log(`[prepare-win-natives] staging dir: ${stagingDir}`);
	console.log(
		`[prepare-win-natives] derived versions: node-pty=${LYDELL_VERSION} libsql=${LIBSQL_WIN_VERSION} ast-grep=${ASTGREP_WIN_VERSION} electron=${ELECTRON_TARGET}`,
	);
	rmSync(stagingDir, { recursive: true, force: true });
	mkdirSync(stagingDir, { recursive: true });

	stageNpmWinPackages();
	stageBetterSqlite3();
	verifyStagedBinaries();

	console.log("[prepare-win-natives] Done. Staged packages:");
	for (const entry of readdirSync(stagingDir)) {
		console.log(`  - ${entry}`);
	}
}

main();
