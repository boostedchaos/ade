/**
 * How the adapter child is LAUNCHED: which executable, and with what env.
 *
 * Two defects live here, and both are silent in a passing suite:
 *
 * - Spawning `process.execPath` without `ELECTRON_RUN_AS_NODE=1` starts an
 *   Electron BROWSER process in the desktop app (`process.type === "browser"`,
 *   Chromium up, dock icon) that never exits on its own — measured against
 *   Electron 40.2.1 at ~5 s still alive, versus 68 ms with the flag. Under
 *   `apps/server` `process.execPath` is the BUN binary, which is the wrong
 *   runtime entirely; the terminal daemon hit exactly this and ships an
 *   exec-path resolver for it (`apps/server/src/routers/terminal.ts`).
 * - Passing the caller's `env` straight through hands the child an environment
 *   with no `PATH` and no `HOME`, so the adapter cannot find its own
 *   `~/.claude` credentials.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { SpawnOptions } from "node:child_process";
import { AcpSession } from "./acp-session";
import {
	setAcpBinaryPathResolver,
	setAcpExecPathResolver,
	spawnAcpChildEnv,
} from "./binary-resolver";
import { FakeAcpChild } from "./fake-acp-child";
import type { SpawnProcess } from "./types";

setAcpBinaryPathResolver(() => "/fake/claude-agent-acp/index.js");

/** Module-level seam with no unregister; restore the default behaviour. */
afterEach(() => {
	setAcpExecPathResolver(() => process.execPath);
});

interface SpawnCall {
	command: string;
	args: string[];
	options: SpawnOptions;
}

function recordingSpawn(child: FakeAcpChild, calls: SpawnCall[]): SpawnProcess {
	return (command, args, options) => {
		calls.push({ command, args, options });
		return child.asChildProcess();
	};
}

describe("spawnAcpChildEnv", () => {
	it("sets ELECTRON_RUN_AS_NODE when the exec path is process.execPath", () => {
		const env = spawnAcpChildEnv(process.execPath, undefined, {
			PATH: "/usr/bin",
			HOME: "/home/kyle",
		});
		expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
	});

	it("does NOT set ELECTRON_RUN_AS_NODE for an overridden exec path", () => {
		const env = spawnAcpChildEnv("node", undefined, { PATH: "/usr/bin" });
		expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
	});

	it("gives a caller-supplied env a real PATH and HOME", () => {
		const env = spawnAcpChildEnv(
			"node",
			{ ANTHROPIC_BASE_URL: "https://example.invalid" },
			{ PATH: "/usr/bin", HOME: "/home/kyle" },
		);
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/home/kyle");
	});

	it("keeps the caller's own vars verbatim, allowlist or not", () => {
		// `buildSafeEnv` is an allowlist and would drop this. It is applied to the
		// INHERITED environment only: a var the caller passed deliberately is the
		// one thing that must survive, or `AcpSessionOptions.env` is a no-op for
		// every provider key it exists to deliver.
		const env = spawnAcpChildEnv(
			"node",
			{ ANTHROPIC_API_KEY: "sk-test" },
			{ PATH: "/usr/bin" },
		);
		expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
	});

	it("drops a non-allowlisted var from the INHERITED environment", () => {
		const env = spawnAcpChildEnv("node", undefined, {
			PATH: "/usr/bin",
			SOME_HOST_SECRET: "leaked",
		});
		expect(env.SOME_HOST_SECRET).toBeUndefined();
	});

	it("lets the caller override an inherited var", () => {
		const env = spawnAcpChildEnv(
			"node",
			{ PATH: "/opt/bin" },
			{
				PATH: "/usr/bin",
			},
		);
		expect(env.PATH).toBe("/opt/bin");
	});
});

describe("AcpSession spawn", () => {
	it("spawns process.execPath WITH ELECTRON_RUN_AS_NODE by default", async () => {
		const child = new FakeAcpChild();
		const calls: SpawnCall[] = [];
		const session = new AcpSession(
			{
				paneId: "pane-electron",
				cwd: process.cwd(),
				spawnProcess: recordingSpawn(child, calls),
			},
			{ onUpdate: () => {}, onError: () => {}, onExit: () => {} },
		);

		await session.start();
		await session.dispose();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe(process.execPath);
		const env = calls[0]?.options.env as Record<string, string> | undefined;
		expect(env?.ELECTRON_RUN_AS_NODE).toBe("1");
	});

	it("honours an exec-path resolver and drops the Electron flag for it", async () => {
		// This is the `apps/server` case: bun cannot run the adapter, so the host
		// app injects plain node — the same override the terminal daemon needs.
		setAcpExecPathResolver(() => "node");

		const child = new FakeAcpChild();
		const calls: SpawnCall[] = [];
		const session = new AcpSession(
			{
				paneId: "pane-node",
				cwd: process.cwd(),
				spawnProcess: recordingSpawn(child, calls),
			},
			{ onUpdate: () => {}, onError: () => {}, onExit: () => {} },
		);

		await session.start();
		await session.dispose();

		expect(calls[0]?.command).toBe("node");
		expect(calls[0]?.args).toEqual(["/fake/claude-agent-acp/index.js"]);
		const env = calls[0]?.options.env as Record<string, string> | undefined;
		expect(env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
	});

	it("never hands the child an env without PATH", async () => {
		const child = new FakeAcpChild();
		const calls: SpawnCall[] = [];
		const session = new AcpSession(
			{
				paneId: "pane-env",
				cwd: process.cwd(),
				spawnProcess: recordingSpawn(child, calls),
				env: { ANTHROPIC_BASE_URL: "https://example.invalid" },
			},
			{ onUpdate: () => {}, onError: () => {}, onExit: () => {} },
		);

		await session.start();
		await session.dispose();

		const env = calls[0]?.options.env as Record<string, string> | undefined;
		expect(env?.ANTHROPIC_BASE_URL).toBe("https://example.invalid");
		expect(env?.PATH).toBeTruthy();
	});
});
