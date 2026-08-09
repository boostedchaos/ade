#!/usr/bin/env bun
/**
 * `ade` — command-line control of the running ADE app.
 *
 * Entry point only: all behaviour lives in run.ts so it can be tested without
 * spawning a process. Uses node builtins exclusively, so the same file runs
 * under bun (source) or node (after a build).
 *
 * Invocation for PATH shims (agent-setup):
 *   #!/bin/sh
 *   exec bun "<repo>/packages/cli/src/index.ts" "$@"
 */
import { run } from "./run";

const exitCode = await run(process.argv.slice(2), {
	stdout: (line) => process.stdout.write(`${line}\n`),
	stderr: (line) => process.stderr.write(`${line}\n`),
});

process.exitCode = exitCode;
// `ade events` holds an open socket; nothing else should keep the loop alive,
// but exit explicitly so a lingering handle cannot turn a finished command
// into a hang.
process.exit(exitCode);
