/**
 * Post-build guard for the packaged Windows app.
 *
 * electron-builder matches `asarUnpack` globs against each file's SOURCE path
 * (relative to the app dir), not its `to` destination. Because the win32 native
 * binaries are staged from `.win32-natives/` and remapped into `node_modules/`,
 * a node_modules-based unpack glob silently fails to match them and they get
 * trapped INSIDE app.asar — where native `require()` cannot load them at runtime
 * (dead terminals + sqlite). This verifier HARD-FAILS the build unless every
 * required win32 `.node`/`.dll` physically exists under `app.asar.unpacked` with
 * a valid PE header, so that regression can never ship silently.
 *
 * Run at the end of `build:win`. Point it at a win-unpacked dir with the first
 * CLI arg, or let it auto-discover `release/win-unpacked`.
 */

import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
} from "node:fs";
import { join } from "node:path";

const projectRoot = join(import.meta.dirname, "..");

// Paths are relative to `<win-unpacked>/resources/app.asar.unpacked`.
const REQUIRED_UNPACKED_BINARIES = [
	"node_modules/better-sqlite3/build/Release/better_sqlite3.node",
	"node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty.node",
	"node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty_console_list.node",
	"node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/conpty.dll",
	"node_modules/@libsql/win32-x64-msvc/index.node",
	"node_modules/@ast-grep/napi-win32-x64-msvc/ast-grep-napi.win32-x64-msvc.node",
];

function fail(message: string): never {
	console.error(`[verify-win-package] ${message}`);
	process.exit(1);
}

/** A PE (Windows) executable/DLL starts with the ASCII bytes "MZ". */
function isPeBinary(filePath: string): boolean {
	if (!existsSync(filePath) || !statSync(filePath).isFile()) return false;
	const fd = openSync(filePath, "r");
	try {
		const buf = Buffer.alloc(2);
		const bytes = readSync(fd, buf, 0, 2, 0);
		return bytes === 2 && buf[0] === 0x4d && buf[1] === 0x5a;
	} finally {
		closeSync(fd);
	}
}

function resolveWinUnpackedDir(): string {
	const arg = process.argv[2];
	if (arg) return arg;

	// Default electron-builder output for win32 x64.
	const candidate = join(projectRoot, "release", "win-unpacked");
	if (existsSync(candidate)) return candidate;

	// Fall back to any release/*win* dir (e.g. per-arch naming).
	const releaseDir = join(projectRoot, "release");
	if (existsSync(releaseDir)) {
		const match = readdirSync(releaseDir).find((d) => /win.*unpacked/i.test(d));
		if (match) return join(releaseDir, match);
	}

	fail(
		"Could not find the win-unpacked directory. Pass it as an argument or run after `electron-builder --win`.",
	);
}

function main(): void {
	const winUnpacked = resolveWinUnpackedDir();
	const asarUnpackedDir = join(
		winUnpacked,
		"resources",
		"app.asar.unpacked",
	);
	console.log(`[verify-win-package] checking: ${asarUnpackedDir}`);

	if (!existsSync(asarUnpackedDir)) {
		fail(
			`app.asar.unpacked not found at ${asarUnpackedDir}. Native modules were NOT unpacked — they are trapped inside app.asar and will fail to load at runtime.`,
		);
	}

	const missing: string[] = [];
	for (const rel of REQUIRED_UNPACKED_BINARIES) {
		const filePath = join(asarUnpackedDir, rel);
		if (!existsSync(filePath)) {
			missing.push(`${rel} (absent from app.asar.unpacked)`);
			continue;
		}
		if (!isPeBinary(filePath)) {
			// Present but wrong format — e.g. a darwin Mach-O binary leaked into the
			// win build, or a truncated/stub file.
			missing.push(`${rel} (present but not a PE/Windows binary)`);
			continue;
		}
		console.log(`  OK (PE x64, unpacked): ${rel}`);
	}

	if (missing.length > 0) {
		fail(
			[
				"Windows package is missing require-able native binaries under app.asar.unpacked:",
				...missing.map((m) => `  - ${m}`),
				"",
				"Native require() (better-sqlite3 / node-pty / libsql / ast-grep) will fail at runtime.",
				"Check the asarUnpack globs in electron-builder.ts match the .win32-natives source paths.",
			].join("\n"),
		);
	}

	console.log(
		"[verify-win-package] OK: all required win32 native binaries are unpacked and PE-valid",
	);
}

main();
