/**
 * The Electron-free binary seam.
 *
 * The resolver is module-level state with no unregister, and Bun shares the
 * module registry across test files in one run — so the "nothing registered"
 * case is tested against a FRESH module instance (a cache-busted import)
 * rather than against whatever the rest of the suite has already registered.
 */
import { describe, expect, it } from "bun:test";
import { AcpSession } from "./acp-session";
import { getAcpBinaryPath, setAcpBinaryPathResolver } from "./binary-resolver";
import { FakeAcpChild } from "./fake-acp-child";

describe("getAcpBinaryPath", () => {
	it("throws acp-binary-unresolved, naming its own fix, when unregistered", async () => {
		// Built at runtime so the bundler does not fold it into the shared copy.
		const specifier = "./binary-resolver.ts?unregistered";
		const fresh = (await import(
			specifier
		)) as typeof import("./binary-resolver");

		expect(() => fresh.getAcpBinaryPath()).toThrow(/^acp-binary-unresolved/);
		expect(() => fresh.getAcpBinaryPath()).toThrow(/setAcpBinaryPathResolver/);
		expect(() => fresh.getAcpBinaryPath()).toThrow(/bootstrap/);
	});

	it("resolves the binary BEFORE spawning anything", async () => {
		// `AcpSession` shares the registered resolver, so an unresolvable seam is
		// simulated by a resolver that throws the same coded error. What is being
		// asserted is the ordering: nothing is spawned when resolution fails.
		setAcpBinaryPathResolver(() => {
			throw new Error("acp-binary-unresolved: no resolver registered");
		});
		const child = new FakeAcpChild();
		let spawned = false;
		const session = new AcpSession(
			{
				paneId: "pane-unresolved",
				cwd: process.cwd(),
				spawnProcess: () => {
					spawned = true;
					return child.asChildProcess();
				},
			},
			{ onUpdate: () => {}, onError: () => {}, onExit: () => {} },
		);

		await expect(session.start()).rejects.toThrow(/^acp-binary-unresolved/);
		expect(spawned).toBe(false);
	});

	it("returns what the registered resolver returns", () => {
		setAcpBinaryPathResolver(() => "/first/claude-agent-acp/index.js");
		expect(getAcpBinaryPath()).toBe("/first/claude-agent-acp/index.js");
	});

	it("lets a re-registration replace the previous resolver", () => {
		setAcpBinaryPathResolver(() => "/second/claude-agent-acp/index.js");
		expect(getAcpBinaryPath()).toBe("/second/claude-agent-acp/index.js");
	});

	it("calls the resolver on every lookup rather than caching it", () => {
		let calls = 0;
		setAcpBinaryPathResolver(() => {
			calls++;
			return `/path-${calls}.js`;
		});

		expect(getAcpBinaryPath()).toBe("/path-1.js");
		expect(getAcpBinaryPath()).toBe("/path-2.js");
		expect(calls).toBe(2);
	});

	it("spawns the resolved script under the current runtime", async () => {
		setAcpBinaryPathResolver(() => "/resolved/claude-agent-acp/index.js");
		const child = new FakeAcpChild();
		const spawnCalls: { command: string; args: string[] }[] = [];

		const session = new AcpSession(
			{
				paneId: "pane-spawn-args",
				cwd: process.cwd(),
				spawnProcess: (command, args) => {
					spawnCalls.push({ command, args: [...args] });
					return child.asChildProcess();
				},
			},
			{ onUpdate: () => {}, onError: () => {}, onExit: () => {} },
		);
		await session.start();

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.command).toBe(process.execPath);
		expect(spawnCalls[0]?.args).toEqual([
			"/resolved/claude-agent-acp/index.js",
		]);

		await session.dispose();
	});
});
