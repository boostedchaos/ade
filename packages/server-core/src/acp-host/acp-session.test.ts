/**
 * `AcpSession` lifecycle: startup, prompt, cancel, the teardown ladder.
 *
 * Every test drives the REAL SDK over `FakeAcpChild`'s real Node streams, so
 * NDJSON framing and JSON-RPC correlation are exercised rather than mocked.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { AcpSession, type AcpSessionHandlers } from "./acp-session";
import { setAcpBinaryPathResolver } from "./binary-resolver";
import { FakeAcpChild, FIXTURE_SESSION_ID, NO_REPLY } from "./fake-acp-child";
import type { AcpExitInfo, AcpSessionUpdate } from "./types";

setAcpBinaryPathResolver(() => "/fake/claude-agent-acp/index.js");

interface Recorded {
	updates: AcpSessionUpdate[];
	errors: Error[];
	exits: AcpExitInfo[];
	handlers: AcpSessionHandlers;
}

function recorder(): Recorded {
	const updates: AcpSessionUpdate[] = [];
	const errors: Error[] = [];
	const exits: AcpExitInfo[] = [];
	return {
		updates,
		errors,
		exits,
		handlers: {
			onUpdate: (update) => updates.push(update),
			onError: (error) => errors.push(error),
			onExit: (info) => exits.push(info),
		},
	};
}

function sessionFor(
	child: FakeAcpChild,
	recorded: Recorded,
	paneId = "pane-1",
): AcpSession {
	return new AcpSession(
		{ paneId, cwd: process.cwd(), spawnProcess: child.spawnProcess },
		recorded.handlers,
	);
}

let child: FakeAcpChild;
let recorded: Recorded;

beforeEach(() => {
	child = new FakeAcpChild();
	recorded = recorder();
});

describe("AcpSession startup", () => {
	it("reaches ready after initialize + session/new", async () => {
		const session = sessionFor(child, recorded);
		const info = await session.start();

		expect(info.paneId).toBe("pane-1");
		expect(info.acpSessionId).toBe(FIXTURE_SESSION_ID);
		expect(info.state).toBe("ready");
		expect(session.sessionState).toBe("ready");

		// The handshake really went over the wire, in order.
		expect(child.sentMethods().slice(0, 2)).toEqual([
			"initialize",
			"session/new",
		]);

		// Config options were seeded from session/new, normalized.
		const model = info.configOptions.find((option) => option.id === "model");
		expect(model?.currentValue).toBe("default");
		expect(model?.values?.map((value) => value.id)).toContain(
			"claude-fable-5[1m]",
		);
		// Boolean options are normalized to a two-value select.
		const fast = info.configOptions.find((option) => option.id === "fast");
		expect(fast?.values?.map((value) => value.id)).toEqual(["true", "false"]);

		await session.dispose();
	});

	it("moves the session into bypassPermissions for the auto-approve policy", async () => {
		const session = sessionFor(child, recorded);
		const info = await session.start();

		const setMode = child.framesFor("session/set_mode")[0];
		expect(setMode?.params?.modeId).toBe("bypassPermissions");
		expect(
			(info.modes as { currentModeId: string } | null)?.currentModeId,
		).toBe("bypassPermissions");

		await session.dispose();
	});

	it("rejects with acp-spawn-failed when the child has no piped stdio", async () => {
		const stdioLess = new FakeAcpChild({ pipeStdout: false });
		const session = new AcpSession(
			{
				paneId: "pane-no-stdio",
				cwd: process.cwd(),
				spawnProcess: stdioLess.spawnProcess,
			},
			recorded.handlers,
		);

		await expect(session.start()).rejects.toThrow(/^acp-spawn-failed/);
	});

	it("surfaces a JSON-RPC error from the agent as acp-spawn-failed carrying acp-rpc-error", async () => {
		child.setHandler("session/new", (_params, id) => {
			if (id !== undefined) child.respondError(id, -32000, "no auth");
			return NO_REPLY;
		});

		const session = sessionFor(child, recorded);
		let message = "";
		try {
			await session.start();
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toMatch(/^acp-spawn-failed/);
		expect(message).toContain("acp-rpc-error");
	});
});

describe("AcpSession prompt and cancel", () => {
	it("resolves with the stopReason while updates stream as events", async () => {
		const deferred = new FakeAcpChild({ autoRespondPrompt: false });
		const session = sessionFor(deferred, recorded);
		await session.start();

		const promptPromise = session.prompt("hello");
		const frame = await deferred.waitFor("session/prompt");
		expect(frame.params?.sessionId).toBe(FIXTURE_SESSION_ID);
		expect(session.sessionState).toBe("prompting");

		deferred.sessionUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "hi there" },
		});
		if (frame.id !== undefined) {
			deferred.respond(frame.id, { stopReason: "end_turn" });
		}

		const result = await promptPromise;
		expect(result.stopReason).toBe("end_turn");
		expect(session.sessionState).toBe("ready");
		expect(recorded.updates).toContainEqual({
			kind: "agent_message_chunk",
			text: "hi there",
		});

		await session.dispose();
	});

	it("sends session/cancel for a live turn", async () => {
		const deferred = new FakeAcpChild({ autoRespondPrompt: false });
		const session = sessionFor(deferred, recorded);
		await session.start();

		const promptPromise = session.prompt("long job");
		const frame = await deferred.waitFor("session/prompt");

		await session.cancel();
		const cancel = await deferred.waitFor("session/cancel");
		expect(cancel.params?.sessionId).toBe(FIXTURE_SESSION_ID);
		// A notification, not a request: no id to answer.
		expect(cancel.id).toBeUndefined();

		if (frame.id !== undefined) {
			deferred.respond(frame.id, { stopReason: "cancelled" });
		}
		expect((await promptPromise).stopReason).toBe("cancelled");

		await session.dispose();
	});

	it("is a silent no-op when cancel is called while idle", async () => {
		const session = sessionFor(child, recorded);
		await session.start();

		await session.cancel();
		expect(child.framesFor("session/cancel")).toHaveLength(0);

		await session.dispose();
	});
});

describe("AcpSession teardown", () => {
	it("runs cancel -> close before killing, and emits exit once", async () => {
		const deferred = new FakeAcpChild({ autoRespondPrompt: false });
		const session = sessionFor(deferred, recorded);
		await session.start();

		const promptPromise = session.prompt("work");
		await deferred.waitFor("session/prompt");

		// The child exits as soon as it is asked to close, like a real adapter.
		deferred.setHandler("session/close", (_params, id) => {
			if (id !== undefined) deferred.respond(id, {});
			queueMicrotask(() => deferred.exit(0, null));
			return NO_REPLY;
		});

		const disposePromise = session.dispose();
		await expect(promptPromise).rejects.toThrow();
		await disposePromise;

		const methods = deferred.sentMethods();
		expect(methods.indexOf("session/cancel")).toBeGreaterThan(-1);
		expect(methods.indexOf("session/close")).toBeGreaterThan(
			methods.indexOf("session/cancel"),
		);
		expect(recorded.exits).toEqual([{ code: 0, signal: null, expected: true }]);
		expect(session.sessionState).toBe("dead");
	});

	it("is idempotent, and concurrent disposes share one ladder", async () => {
		const session = sessionFor(child, recorded);
		await session.start();

		child.setHandler("session/close", (_params, id) => {
			if (id !== undefined) child.respond(id, {});
			queueMicrotask(() => child.exit(0, null));
			return NO_REPLY;
		});

		const first = session.dispose();
		const second = session.dispose();
		expect(second).toBe(first);
		await Promise.all([first, second, session.dispose()]);

		// One ladder means exactly one session/close and exactly one exit event.
		expect(child.framesFor("session/close")).toHaveLength(1);
		expect(recorded.exits).toHaveLength(1);
	});

	it("rejects every method with acp-session-disposed after teardown", async () => {
		const session = sessionFor(child, recorded);
		await session.start();

		child.setHandler("session/close", (_params, id) => {
			if (id !== undefined) child.respond(id, {});
			queueMicrotask(() => child.exit(0, null));
			return NO_REPLY;
		});
		await session.dispose();

		await expect(session.prompt("nope")).rejects.toThrow(
			/^acp-session-disposed/,
		);
		await expect(session.setMode("plan")).rejects.toThrow(
			/^acp-session-disposed/,
		);
		await expect(session.setConfigOption("model", "sonnet")).rejects.toThrow(
			/^acp-session-disposed/,
		);
		// cancel() never throws for "already gone".
		await session.cancel();
	});

	it("kills the real process tree it was given a pid for", async () => {
		// The only test that hands the ladder a REAL pid: a `sleep` we own, so
		// step 4 (treeKillWithEscalation) is proved rather than assumed.
		const victim = spawn("sleep", ["30"], { stdio: "ignore" });
		await new Promise<void>((resolve) => victim.once("spawn", () => resolve()));
		const pid = victim.pid;
		expect(pid).toBeDefined();

		const killable = new FakeAcpChild({ pid });
		victim.on("exit", (code, signal) => killable.exit(code, signal));

		const session = sessionFor(killable, recorded, "pane-kill");
		await session.start();
		await session.dispose();

		if (pid !== undefined) {
			expect(() => process.kill(pid, 0)).toThrow();
		}
		expect(recorded.exits[0]?.expected).toBe(true);
	}, 15_000);

	it("force-disposes when the child never exits (KILL_TIMEOUT_MS)", async () => {
		// No pid, so no signal is ever sent and the fake child never exits: the
		// only thing that can finish this teardown is the 5 s fail-safe timer.
		const stuck = new FakeAcpChild({ exitOnStdinClose: false });
		const session = sessionFor(stuck, recorded, "pane-stuck");
		await session.start();

		const started = Date.now();
		await session.dispose();
		const elapsed = Date.now() - started;

		expect(elapsed).toBeGreaterThanOrEqual(4500);
		expect(session.sessionState).toBe("dead");
		expect(recorded.exits).toHaveLength(1);
		expect(recorded.exits[0]?.expected).toBe(true);
	}, 20_000);
});
