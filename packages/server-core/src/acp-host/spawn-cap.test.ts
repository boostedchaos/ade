/**
 * The startup-concurrency cap and its env override.
 *
 * The cap bounds simultaneous STARTUPS, not live sessions: a team spawn burst
 * creates several panes back to back, and each one costs a handshake.
 */
import { describe, expect, it } from "bun:test";
import { AcpHost, resolveMaxConcurrentAcpSpawns } from "./acp-host";
import { setAcpBinaryPathResolver } from "./binary-resolver";
import { FakeAcpChild, NO_REPLY } from "./fake-acp-child";

setAcpBinaryPathResolver(() => "/fake/claude-agent-acp/index.js");

describe("resolveMaxConcurrentAcpSpawns", () => {
	it("defaults to 5 when the override is unset or blank", () => {
		expect(resolveMaxConcurrentAcpSpawns(undefined)).toBe(5);
		expect(resolveMaxConcurrentAcpSpawns("")).toBe(5);
		expect(resolveMaxConcurrentAcpSpawns("   ")).toBe(5);
	});

	it("accepts a positive integer override", () => {
		expect(resolveMaxConcurrentAcpSpawns("1")).toBe(1);
		expect(resolveMaxConcurrentAcpSpawns("16")).toBe(16);
		expect(resolveMaxConcurrentAcpSpawns(" 4 ")).toBe(4);
	});

	it("falls back rather than throwing on a malformed value", () => {
		// A bad override must never stop the ACP host from starting at all.
		for (const bad of [
			"0",
			"-1",
			"abc",
			"3.5",
			"1e3",
			"0x10",
			"NaN",
			"Infinity",
			"5 panes",
		]) {
			expect(resolveMaxConcurrentAcpSpawns(bad)).toBe(5);
		}
	});

	it("honours an explicit fallback", () => {
		expect(resolveMaxConcurrentAcpSpawns("nonsense", 2)).toBe(2);
	});

	it("reads SUPERSET_ACP_MAX_CONCURRENT_SPAWNS from the environment", () => {
		const previous = process.env.SUPERSET_ACP_MAX_CONCURRENT_SPAWNS;
		try {
			process.env.SUPERSET_ACP_MAX_CONCURRENT_SPAWNS = "3";
			expect(resolveMaxConcurrentAcpSpawns()).toBe(3);
			process.env.SUPERSET_ACP_MAX_CONCURRENT_SPAWNS = "not-a-number";
			expect(resolveMaxConcurrentAcpSpawns()).toBe(5);
			delete process.env.SUPERSET_ACP_MAX_CONCURRENT_SPAWNS;
			expect(resolveMaxConcurrentAcpSpawns()).toBe(5);
		} finally {
			if (previous === undefined) {
				delete process.env.SUPERSET_ACP_MAX_CONCURRENT_SPAWNS;
			} else {
				process.env.SUPERSET_ACP_MAX_CONCURRENT_SPAWNS = previous;
			}
		}
	});
});

describe("startup concurrency cap", () => {
	it("defers the N+1th startup until a slot frees", async () => {
		const previous = process.env.SUPERSET_ACP_MAX_CONCURRENT_SPAWNS;
		process.env.SUPERSET_ACP_MAX_CONCURRENT_SPAWNS = "1";
		try {
			// The cap is read when the host is constructed.
			const host = new AcpHost();

			const first = new FakeAcpChild({ sessionId: "acp-first" });
			const second = new FakeAcpChild({ sessionId: "acp-second" });
			let firstNewSessionId: number | string | undefined;
			first.setHandler("session/new", (_params, id) => {
				firstNewSessionId = id;
				return NO_REPLY; // hold the slot open
			});

			let secondSpawned = false;
			const firstPromise = host.createSession({
				paneId: "pane-first",
				cwd: process.cwd(),
				spawnProcess: first.spawnProcess,
			});
			const secondPromise = host.createSession({
				paneId: "pane-second",
				cwd: process.cwd(),
				spawnProcess: () => {
					secondSpawned = true;
					return second.asChildProcess();
				},
			});

			await first.waitFor("session/new");
			await Bun.sleep(20);
			// Slot taken: the second pane has not even been spawned yet.
			expect(secondSpawned).toBe(false);
			expect(second.received).toHaveLength(0);

			if (firstNewSessionId !== undefined) {
				first.respond(firstNewSessionId, {
					sessionId: "acp-first",
					modes: null,
					configOptions: [],
				});
			}
			await firstPromise;

			// Slot released: the second startup proceeds on its own.
			const info = await secondPromise;
			expect(secondSpawned).toBe(true);
			expect(info.acpSessionId).toBe("acp-second");

			await host.disposeAll();
		} finally {
			if (previous === undefined) {
				delete process.env.SUPERSET_ACP_MAX_CONCURRENT_SPAWNS;
			} else {
				process.env.SUPERSET_ACP_MAX_CONCURRENT_SPAWNS = previous;
			}
		}
	});
});
