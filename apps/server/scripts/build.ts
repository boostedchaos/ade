/**
 * Bundle the terminal-host daemon + pty-subprocess for plain Node.
 *
 * The daemon must run under Node, not bun: node-pty's ConPTY conin socket
 * (fd-wrapped net.Socket) breaks under bun on Windows (ERR_SOCKET_CLOSED on
 * write). Bundling to CJS also inlines the xterm window polyfill in import
 * order and erases TS enums, so no experimental Node flags are needed.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const outDir = join(import.meta.dirname, "..", "dist");
const terminalHostDir = dirname(
	require.resolve("@ade/server-core/terminal-host/daemon"),
);

const common = {
	bundle: true,
	platform: "node" as const,
	format: "cjs" as const,
	target: "node20",
	external: ["node-pty"],
	sourcemap: true,
	logLevel: "info" as const,
};

await build({
	...common,
	entryPoints: [join(terminalHostDir, "daemon.ts")],
	outfile: join(outDir, "terminal-host.cjs"),
});

await build({
	...common,
	entryPoints: [join(terminalHostDir, "pty-subprocess.ts")],
	outfile: join(outDir, "pty-subprocess.cjs"),
});

console.log("daemon bundles written to", outDir);

// Server bundle: same constraints as the daemon (node-pty + better-sqlite3
// are unusable under bun on Windows), so ade-server itself ships as a
// CJS bundle run by Node.
await build({
	...common,
	entryPoints: [join(import.meta.dirname, "..", "src", "cli.ts")],
	external: ["node-pty", "better-sqlite3"],
	outfile: join(outDir, "server.cjs"),
});

// local-db resolves migrations from <bundle>/../resources/migrations.
const { cpSync } = await import("node:fs");
const migrationsSrc = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"packages",
	"local-db",
	"drizzle",
);
cpSync(migrationsSrc, join(outDir, "..", "resources", "migrations"), {
	recursive: true,
});
console.log("server bundle + migrations ready");
