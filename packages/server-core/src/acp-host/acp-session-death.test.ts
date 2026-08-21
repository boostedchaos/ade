/**
 * Unexpected child death.
 *
 * The design's rule: an `exit` with no teardown in progress fails the in-flight
 * prompt with `acp-session-died`, emits `error:` then `exit:{expected:false}`,
 * and leaves the registry empty. No auto-restart in Phase 1.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { AcpHost } from "./acp-host";
import { AcpSession, type AcpSessionHandlers } from "./acp-session";
import { setAcpBinaryPathResolver } from "./binary-resolver";
import { FakeAcpChild } from "./fake-acp-child";
import type { AcpExitInfo } from "./types";

setAcpBinaryPathResolver(() => "/fake/claude-agent-acp/index.js");

let errors: Error[];
let exits: AcpExitInfo[];
/** Tagged in arrival order, so "error before exit" is actually asserted. */
let order: string[];
let handlers: AcpSessionHandlers;

beforeEach(() => {
	errors = [];
	exits = [];
	order = [];
	handlers = {
		onUpdate: () => {},
		onError: (error) => {
			errors.push(error);
			order.push("error");
		},
		onExit: (info) => {
			exits.push(info);
			order.push("exit");
		},
	};
});

describe("AcpSession death mid-turn", () => {
	it("rejects the in-flight prompt and emits error: then exit:{expected:false}", async () => {
		const child = new FakeAcpChild({ autoRespondPrompt: false });
		const session = new AcpSession(
			{
				paneId: "pane-dead",
				cwd: process.cwd(),
				spawnProcess: child.spawnProcess,
			},
			handlers,
		);
		await session.start();

		const promptPromise = session.prompt("start a long turn");
		await child.waitFor("session/prompt");

		child.exit(1, "SIGKILL");

		await expect(promptPromise).rejects.toThrow(/^acp-session-died/);
		await expect(promptPromise).rejects.toThrow(/pane-dead/);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/^acp-session-died/);
		expect(exits).toEqual([{ code: 1, signal: "SIGKILL", expected: false }]);
		expect(session.sessionState).toBe("dead");

		// The error is emitted BEFORE the exit — Phase 2 needs the reason first.
		expect(order).toEqual(["error", "exit"]);
		expect(errors[0]?.message).toContain("code 1");
	});

	it("emits the same pair with no rejection when the child dies idle", async () => {
		const child = new FakeAcpChild();
		const session = new AcpSession(
			{
				paneId: "pane-idle-death",
				cwd: process.cwd(),
				spawnProcess: child.spawnProcess,
			},
			handlers,
		);
		await session.start();

		child.exit(0, null);
		await Bun.sleep(10);

		expect(errors).toHaveLength(1);
		expect(exits).toEqual([{ code: 0, signal: null, expected: false }]);
	});

	it("empties the AcpHost registry when the child dies", async () => {
		const child = new FakeAcpChild({ autoRespondPrompt: false });
		const host = new AcpHost();
		const seenErrors: Error[] = [];
		const seenExits: AcpExitInfo[] = [];
		host.on("error:pane-registry", (error: Error) => seenErrors.push(error));
		host.on("exit:pane-registry", (info: AcpExitInfo) => seenExits.push(info));

		await host.createSession({
			paneId: "pane-registry",
			cwd: process.cwd(),
			spawnProcess: child.spawnProcess,
		});
		expect(host.listSessions()).toHaveLength(1);

		const promptPromise = host.prompt("pane-registry", "hello");
		await child.waitFor("session/prompt");
		child.exit(9, null);

		await expect(promptPromise).rejects.toThrow(/^acp-session-died/);
		expect(host.getSessionInfo("pane-registry")).toBeUndefined();
		expect(host.listSessions()).toHaveLength(0);
		expect(seenErrors[0]?.message).toMatch(/^acp-session-died/);
		expect(seenExits).toEqual([{ code: 9, signal: null, expected: false }]);

		// No auto-restart: nothing respawned behind our back.
		await Bun.sleep(20);
		expect(host.listSessions()).toHaveLength(0);
	});

	it("does not report a death when the child exits during teardown", async () => {
		const child = new FakeAcpChild();
		const session = new AcpSession(
			{
				paneId: "pane-clean",
				cwd: process.cwd(),
				spawnProcess: child.spawnProcess,
			},
			handlers,
		);
		await session.start();

		await session.dispose();

		expect(errors).toHaveLength(0);
		expect(exits).toEqual([{ code: 0, signal: null, expected: true }]);
	});
});
