#!/usr/bin/env node
// Cross-platform postinstall (Node so it runs on Windows too — no bash).
//
// 1. Guard against infinite recursion: `electron-builder install-app-deps` can
//    trigger nested installs which would re-run postinstall, spawning hundreds
//    of processes.
// 2. Run sherif for workspace validation.
// 3. Install/rebuild native dependencies for the desktop app.

import { spawnSync } from "node:child_process";

if (process.env.SUPERSET_POSTINSTALL_RUNNING) {
	process.exit(0);
}

const env = { ...process.env, SUPERSET_POSTINSTALL_RUNNING: "1" };

/**
 * Run a command, inheriting stdio; exit the process on failure. The command is
 * passed as a single string with shell:true so Windows resolves the `.cmd`
 * shims for bun/sherif on PATH. All inputs here are static/trusted literals.
 */
function run(commandLine) {
	const result = spawnSync(commandLine, {
		stdio: "inherit",
		env,
		shell: true,
	});
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

// Workspace validation.
run("sherif");

// Install native dependencies for the desktop app.
run("bun run --filter=@ade/desktop install:deps");
