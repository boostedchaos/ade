/**
 * `AcpHost`: the pane-keyed registry, the dedupe, per-pane event fan-out and
 * `disposeAll`.
 */
import { describe, expect, it } from "bun:test";
import { AcpHost, getAcpHost } from "./acp-host";
import { setAcpBinaryPathResolver } from "./binary-resolver";
import { FakeAcpChild, NO_REPLY } from "./fake-acp-child";
import type { AcpSessionUpdate } from "./types";

setAcpBinaryPathResolver(() => "/fake/claude-agent-acp/index.js");

describe("AcpHost registry", () => {
	it("keys sessions by paneId and reports them", async () => {
		const host = new AcpHost();
		const a = new FakeAcpChild({ sessionId: "acp-a" });
		const b = new FakeAcpChild({ sessionId: "acp-b" });

		await host.createSession({
			paneId: "pane-a",
			cwd: process.cwd(),
			spawnProcess: a.spawnProcess,
		});
		await host.createSession({
			paneId: "pane-b",
			cwd: process.cwd(),
			spawnProcess: b.spawnProcess,
		});

		expect(host.getSessionInfo("pane-a")?.acpSessionId).toBe("acp-a");
		expect(host.getSessionInfo("pane-b")?.acpSessionId).toBe("acp-b");
		expect(
			host
				.listSessions()
				.map((info) => info.paneId)
				.sort(),
		).toEqual(["pane-a", "pane-b"]);

		await host.disposeAll();
		expect(host.listSessions()).toHaveLength(0);
	});

	it("spawns ONE child for concurrent createSession calls on one pane", async () => {
		const host = new AcpHost();
		let spawnCount = 0;
		const child = new FakeAcpChild();

		const options = {
			paneId: "pane-dedupe",
			cwd: process.cwd(),
			spawnProcess: () => {
				spawnCount++;
				return child.asChildProcess();
			},
		};

		const first = host.createSession(options);
		const second = host.createSession(options);
		// Same pending promise, not merely an equal result.
		expect(second).toBe(first);

		const [infoA, infoB] = await Promise.all([first, second]);
		expect(spawnCount).toBe(1);
		expect(infoA.acpSessionId).toBe(infoB.acpSessionId);
		// Exactly one handshake went over the wire.
		expect(child.framesFor("session/new")).toHaveLength(1);

		// And a later call for a live pane returns its info rather than respawning.
		const third = await host.createSession(options);
		expect(third.paneId).toBe("pane-dedupe");
		expect(spawnCount).toBe(1);

		await host.disposeAll();
	});

	it("namespaces events per pane", async () => {
		const host = new AcpHost();
		const a = new FakeAcpChild({ sessionId: "acp-a" });
		const b = new FakeAcpChild({ sessionId: "acp-b" });
		const toA: AcpSessionUpdate[] = [];
		const toB: AcpSessionUpdate[] = [];
		host.on("update:pane-a", (update: AcpSessionUpdate) => toA.push(update));
		host.on("update:pane-b", (update: AcpSessionUpdate) => toB.push(update));

		await host.createSession({
			paneId: "pane-a",
			cwd: process.cwd(),
			spawnProcess: a.spawnProcess,
		});
		await host.createSession({
			paneId: "pane-b",
			cwd: process.cwd(),
			spawnProcess: b.spawnProcess,
		});

		a.sessionUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "for A" },
		});
		await Bun.sleep(20);

		expect(toA).toEqual([{ kind: "agent_message_chunk", text: "for A" }]);
		expect(toB).toHaveLength(0);

		await host.disposeAll();
	});

	it("rejects methods for an unknown paneId with acp-session-not-found", async () => {
		const host = new AcpHost();

		await expect(host.prompt("nope", "hi")).rejects.toThrow(
			/^acp-session-not-found/,
		);
		await expect(host.setMode("nope", "plan")).rejects.toThrow(
			/^acp-session-not-found/,
		);
		await expect(
			host.setConfigOption("nope", "model", "sonnet"),
		).rejects.toThrow(/^acp-session-not-found/);
		expect(host.getSessionInfo("nope")).toBeUndefined();

		// cancel and dispose resolve for "already gone" rather than throwing.
		await host.cancel("nope");
		await host.disposeSession("nope");
	});

	it("disposeAll tears down every session", async () => {
		const host = new AcpHost();
		const children = [
			new FakeAcpChild({ sessionId: "acp-1" }),
			new FakeAcpChild({ sessionId: "acp-2" }),
			new FakeAcpChild({ sessionId: "acp-3" }),
		];
		await Promise.all(
			children.map((child, index) =>
				host.createSession({
					paneId: `pane-${index}`,
					cwd: process.cwd(),
					spawnProcess: child.spawnProcess,
				}),
			),
		);
		expect(host.listSessions()).toHaveLength(3);

		await host.disposeAll();

		expect(host.listSessions()).toHaveLength(0);
		for (const child of children) {
			expect(child.framesFor("session/close")).toHaveLength(1);
		}
	});

	it("removes pane listeners when a session is disposed", async () => {
		const host = new AcpHost();
		const child = new FakeAcpChild();
		host.on("update:pane-listeners", () => {});
		host.on("exit:pane-listeners", () => {});

		await host.createSession({
			paneId: "pane-listeners",
			cwd: process.cwd(),
			spawnProcess: child.spawnProcess,
		});
		await host.disposeSession("pane-listeners");

		expect(host.listenerCount("update:pane-listeners")).toBe(0);
		expect(host.listenerCount("exit:pane-listeners")).toBe(0);
	});
});

describe("getAcpHost", () => {
	it("returns the same instance every time", () => {
		expect(getAcpHost()).toBe(getAcpHost());
	});
});

describe("AcpHost disposing a still-starting pane", () => {
	/** A child that answers `initialize` never, so `start()` stays pending. */
	function hangingChild(): FakeAcpChild {
		const child = new FakeAcpChild();
		child.setHandler("initialize", () => NO_REPLY);
		return child;
	}

	it("tears down a child whose start() has not resolved", async () => {
		// `pendingSessions` holds a Promise<AcpSessionInfo>, which is not
		// something you can kill — before the fix `disposeSession` read only the
		// registry, found nothing, and returned while the child ran on.
		const host = new AcpHost();
		const child = hangingChild();
		let exited = false;
		child.on("exit", () => {
			exited = true;
		});

		const startup = host.createSession({
			paneId: "pane-starting",
			cwd: process.cwd(),
			spawnProcess: child.spawnProcess,
		});
		const outcome = startup.then(
			() => "resolved",
			(error: Error) => error.message,
		);
		await child.waitFor("initialize");

		await host.disposeSession("pane-starting");

		expect(exited).toBe(true);
		expect(host.listSessions()).toHaveLength(0);
		expect(await outcome).toMatch(/^acp-session-disposed/);
	}, 30_000);

	it("disposeAll reaches a starting pane too", async () => {
		const host = new AcpHost();
		const child = hangingChild();
		let exited = false;
		child.on("exit", () => {
			exited = true;
		});

		const startup = host.createSession({
			paneId: "pane-starting-all",
			cwd: process.cwd(),
			spawnProcess: child.spawnProcess,
		});
		const outcome = startup.then(
			() => "resolved",
			(error: Error) => error.message,
		);
		await child.waitFor("initialize");

		await host.disposeAll();

		expect(exited).toBe(true);
		expect(await outcome).toMatch(/^acp-session-disposed/);
	}, 30_000);
});

describe("AcpHost listener hygiene", () => {
	it("drops pane listeners when the child dies unexpectedly", async () => {
		// The registry entry goes in the death path, so `disposeSession` returns
		// early at its own guard and its `finally` cleanup never runs. Before the
		// fix the next session on that pane fed the dead generation's listeners.
		const host = new AcpHost();
		const first = new FakeAcpChild({ sessionId: "acp-gen-1" });
		const stale: AcpSessionUpdate[] = [];
		host.on("update:pane-gen", (update: AcpSessionUpdate) =>
			stale.push(update),
		);

		await host.createSession({
			paneId: "pane-gen",
			cwd: process.cwd(),
			spawnProcess: first.spawnProcess,
		});

		first.exit(9, null);
		await Bun.sleep(20);
		expect(host.listSessions()).toHaveLength(0);
		expect(host.listenerCount("update:pane-gen")).toBe(0);

		// A fresh generation on the same pane must not reach the old listener.
		const second = new FakeAcpChild({ sessionId: "acp-gen-2" });
		await host.createSession({
			paneId: "pane-gen",
			cwd: process.cwd(),
			spawnProcess: second.spawnProcess,
		});
		second.sessionUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "second generation" },
		});
		await Bun.sleep(20);

		expect(stale).toHaveLength(0);

		await host.disposeAll();
	}, 30_000);

	it("drops pane listeners when start() fails", async () => {
		const host = new AcpHost();
		const child = new FakeAcpChild();
		child.setHandler("session/new", () => {
			throw new Error("no session for you");
		});
		const exits: unknown[] = [];
		host.on("update:pane-badstart", () => {});
		host.on("exit:pane-badstart", (info: unknown) => exits.push(info));

		await expect(
			host.createSession({
				paneId: "pane-badstart",
				cwd: process.cwd(),
				spawnProcess: child.spawnProcess,
			}),
		).rejects.toThrow(/^acp-spawn-failed/);

		expect(host.listenerCount("update:pane-badstart")).toBe(0);
		expect(host.listenerCount("exit:pane-badstart")).toBe(0);
		// A pane that never reached `ready` was never a pane the caller had; the
		// `createSession` rejection is its report, not an `exit` event.
		expect(exits).toHaveLength(0);
	}, 30_000);
});
