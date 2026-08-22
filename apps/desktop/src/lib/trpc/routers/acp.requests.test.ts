/**
 * Phase 6 router surface: answering a parked request, and the buffer's edges.
 *
 * `acp.test.ts` covers the mechanisms — a buffer that drains, a policy that is
 * read per session, a blocked request that reaches the pane. What is here is
 * what that file does not touch: the two answer mutations (nothing asserts
 * they forward anything at all), the error a spent requestId produces, the
 * exact boundary the drop counter turns on, and the buffer's own lifetime
 * across dispose.
 */

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { AcpSessionInfo } from "@ade/server-core/acp-host";
import type { Unsubscribable } from "@trpc/server/observable";
import { type AcpPaneEvent, createAcpRouter } from "./acp";

function info(paneId: string): AcpSessionInfo {
	return {
		paneId,
		acpSessionId: `acp-${paneId}`,
		state: "ready",
		modes: null,
		configOptions: [],
		configSeq: 1,
		availableCommands: [],
		restored: "fresh",
	};
}

interface AnswerPermissionCall {
	paneId: string;
	requestId: string;
	optionId: string;
}
interface AnswerElicitationCall {
	paneId: string;
	requestId: string;
	answer: unknown;
}

class FakeAcpHost extends EventEmitter {
	sessions = new Map<string, AcpSessionInfo>();
	answerPermissionCalls: AnswerPermissionCall[] = [];
	answerElicitationCalls: AnswerElicitationCall[] = [];
	disposeCalls: string[] = [];
	/** Set to make either answer mutation throw, the way a spent id does. */
	answerError: Error | null = null;

	createSession(options: { paneId: string }): Promise<AcpSessionInfo> {
		const created = info(options.paneId);
		this.sessions.set(options.paneId, created);
		return Promise.resolve(created);
	}

	getSessionInfo(paneId: string): AcpSessionInfo | undefined {
		return this.sessions.get(paneId);
	}

	answerPermission(paneId: string, requestId: string, optionId: string): void {
		this.answerPermissionCalls.push({ paneId, requestId, optionId });
		if (this.answerError) throw this.answerError;
	}

	answerElicitation(paneId: string, requestId: string, answer: unknown): void {
		this.answerElicitationCalls.push({ paneId, requestId, answer });
		if (this.answerError) throw this.answerError;
	}

	async disposeSession(paneId: string): Promise<void> {
		this.disposeCalls.push(paneId);
		this.sessions.delete(paneId);
		this.removePaneListeners(paneId);
	}

	async cancel(): Promise<void> {}

	removePaneListeners(paneId: string): void {
		for (const name of [
			"update",
			"exit",
			"error",
			"permission",
			"elicitation",
		]) {
			this.removeAllListeners(`${name}:${paneId}`);
		}
	}
}

function makeCaller(
	host: FakeAcpHost,
	permissionPolicy?: () => "auto-approve" | "prompt",
) {
	const appRouter = createAcpRouter({
		// biome-ignore lint/suspicious/noExplicitAny: the fake implements the surface the router uses, not the whole AcpHost class
		host: host as any,
		childEnv: () => ({}),
		...(permissionPolicy ? { permissionPolicy } : {}),
	});
	return {
		router: appRouter,
		// biome-ignore lint/suspicious/noExplicitAny: the caller's inferred type is not the subject of these tests
		caller: appRouter.createCaller({}) as any,
	};
}

async function subscribe(
	appRouter: ReturnType<typeof createAcpRouter>,
	paneId: string,
): Promise<{ events: AcpPaneEvent[]; subscription: Unsubscribable }> {
	const events: AcpPaneEvent[] = [];
	const observableResult = (await appRouter
		.createCaller({})
		// biome-ignore lint/suspicious/noExplicitAny: the caller resolves to the raw observable for a subscription procedure
		.events({ paneId })) as any;
	const subscription: Unsubscribable = observableResult.subscribe({
		next: (event: AcpPaneEvent) => events.push(event),
	});
	return { events, subscription };
}

// =============================================================================

describe("answerPermission", () => {
	it("forwards paneId, requestId and optionId to the host", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.answerPermission({
			paneId: "pane-1",
			requestId: "perm-3",
			optionId: "reject",
		});

		expect(result).toEqual({ ok: true });
		expect(host.answerPermissionCalls).toEqual([
			{ paneId: "pane-1", requestId: "perm-3", optionId: "reject" },
		]);
	});

	it("propagates the host's coded error for an id that is no longer pending", async () => {
		// The ordinary shape of a double-click and of an answer that lost a race
		// with a cancelled turn. The renderer branches on this code to mark the
		// card unavailable rather than reporting a failure.
		const host = new FakeAcpHost();
		host.answerError = new Error(
			'acp-request-not-found: no pending permission request "perm-3" for pane pane-1',
		);
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		await expect(
			caller.answerPermission({
				paneId: "pane-1",
				requestId: "perm-3",
				optionId: "allow",
			}),
		).rejects.toThrow(/acp-request-not-found/);
	});

	it("rejects a paneId with path separators before reaching the host", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);

		await expect(
			caller.answerPermission({
				paneId: "../pane-1",
				requestId: "perm-1",
				optionId: "allow",
			}),
		).rejects.toThrow();
		expect(host.answerPermissionCalls).toHaveLength(0);
	});

	it("refuses an empty requestId or optionId", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);

		await expect(
			caller.answerPermission({
				paneId: "pane-1",
				requestId: "",
				optionId: "allow",
			}),
		).rejects.toThrow();
		await expect(
			caller.answerPermission({
				paneId: "pane-1",
				requestId: "perm-1",
				optionId: "",
			}),
		).rejects.toThrow();
		expect(host.answerPermissionCalls).toHaveLength(0);
	});
});

describe("answerElicitation", () => {
	it("forwards an accept with its content untouched", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		await caller.answerElicitation({
			paneId: "pane-1",
			requestId: "elicit-1",
			answer: {
				action: "accept",
				content: { question_0: "Rewrite", tags: ["a", "b"] },
			},
		});

		expect(host.answerElicitationCalls).toEqual([
			{
				paneId: "pane-1",
				requestId: "elicit-1",
				answer: {
					action: "accept",
					content: { question_0: "Rewrite", tags: ["a", "b"] },
				},
			},
		]);
	});

	it.each([["decline"], ["cancel"]])("forwards a bare %s", async (action) => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);

		await caller.answerElicitation({
			paneId: "pane-1",
			requestId: "elicit-1",
			answer: { action },
		});

		expect(host.answerElicitationCalls[0]?.answer).toEqual({ action });
	});

	it("refuses content values the host would never have rendered a form for", async () => {
		// String and string-array only. A number or boolean here could not have
		// come from a form this client drew, so it is a caller bug, not input.
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);

		await expect(
			caller.answerElicitation({
				paneId: "pane-1",
				requestId: "elicit-1",
				answer: { action: "accept", content: { count: 3 } },
			}),
		).rejects.toThrow();
		await expect(
			caller.answerElicitation({
				paneId: "pane-1",
				requestId: "elicit-1",
				answer: { action: "accept", content: { flag: true } },
			}),
		).rejects.toThrow();
		expect(host.answerElicitationCalls).toHaveLength(0);
	});

	it("refuses an action the union does not name", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);

		await expect(
			caller.answerElicitation({
				paneId: "pane-1",
				requestId: "elicit-1",
				answer: { action: "accepted", content: {} },
			}),
		).rejects.toThrow();
		expect(host.answerElicitationCalls).toHaveLength(0);
	});

	it("propagates the host's coded error for a spent id", async () => {
		const host = new FakeAcpHost();
		host.answerError = new Error(
			'acp-request-not-found: no pending elicitation request "elicit-1" for pane pane-1',
		);
		const { caller } = makeCaller(host);

		await expect(
			caller.answerElicitation({
				paneId: "pane-1",
				requestId: "elicit-1",
				answer: { action: "decline" },
			}),
		).rejects.toThrow(/acp-request-not-found/);
	});
});

describe("event buffer edges (A2)", () => {
	it("drops NOTHING at exactly the cap — the boundary, not near it", async () => {
		// `acp.test.ts` asserts the counter at cap+2. An off-by-one that fired a
		// spurious "1 event dropped" divider on a full-but-intact backlog would
		// pass there and lie to the user here.
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		for (let index = 0; index < 5000; index++) {
			host.emit("update:pane-1", {
				kind: "agent_message_chunk",
				text: `chunk-${index}`,
			});
		}

		const { events } = await subscribe(appRouter, "pane-1");

		expect(events).toHaveLength(5000);
		expect(events.some((event) => event.type === "events_dropped")).toBe(false);
		expect(events[0]).toEqual({
			type: "update",
			update: { kind: "agent_message_chunk", text: "chunk-0" },
		});
	});

	it("PROVES THE COUNTER FIRES: one past the cap reports exactly one drop", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		for (let index = 0; index < 5001; index++) {
			host.emit("update:pane-1", {
				kind: "agent_message_chunk",
				text: `chunk-${index}`,
			});
		}

		const { events } = await subscribe(appRouter, "pane-1");

		expect(events[0]).toEqual({ type: "events_dropped", count: 1 });
		expect(events).toHaveLength(5001);
		expect(events[1]).toEqual({
			type: "update",
			update: { kind: "agent_message_chunk", text: "chunk-1" },
		});
	});

	it("delivers the drop notice ONCE and only at the front", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		for (let index = 0; index < 5100; index++) {
			host.emit("update:pane-1", {
				kind: "agent_message_chunk",
				text: `chunk-${index}`,
			});
		}

		const { events } = await subscribe(appRouter, "pane-1");

		const dropped = events.filter((event) => event.type === "events_dropped");
		expect(dropped).toEqual([{ type: "events_dropped", count: 100 }]);
		expect(events.indexOf(dropped[0] as AcpPaneEvent)).toBe(0);
		// The tail is what survives: the newest frames describe the state the
		// pane is about to be in.
		expect(events[events.length - 1]).toEqual({
			type: "update",
			update: { kind: "agent_message_chunk", text: "chunk-5099" },
		});
	});

	it("drains a MIXED backlog in the order it was emitted", async () => {
		// Every union member goes through one buffer. A per-kind fan-out that
		// grouped requests after updates would reorder a card away from the tool
		// call it belongs to, and a same-kind-only test cannot see that.
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		host.emit("update:pane-1", { kind: "user_message_chunk", text: "hi" });
		host.emit("permission:pane-1", {
			requestId: "perm-1",
			title: "Write beta.txt",
			options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
		});
		host.emit("update:pane-1", { kind: "agent_message_chunk", text: "ok" });
		host.emit("elicitation:pane-1", {
			requestId: "elicit-1",
			message: "Which?",
			form: { fields: [] },
		});
		host.emit("error:pane-1", new Error("acp-session-died: gone"));

		const { events } = await subscribe(appRouter, "pane-1");

		expect(events.map((event) => event.type)).toEqual([
			"update",
			"permission_request",
			"update",
			"elicitation_request",
			"session_error",
		]);
	});

	it("throws the backlog away on dispose — nothing will ever drain it", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		host.emit("update:pane-1", { kind: "agent_message_chunk", text: "old" });

		await caller.dispose({ paneId: "pane-1" });
		const { events } = await subscribe(appRouter, "pane-1");

		// A dead child's conversation replaying into the next generation's pane
		// would read as the new session having already said something.
		expect(events).toHaveLength(0);
	});

	it("keeps each pane's backlog to itself", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		await caller.ensureSession({ paneId: "pane-2", cwd: "/repo" });
		host.emit("update:pane-1", { kind: "agent_message_chunk", text: "one" });
		host.emit("update:pane-2", { kind: "agent_message_chunk", text: "two" });

		const first = await subscribe(appRouter, "pane-1");
		const second = await subscribe(appRouter, "pane-2");

		expect(first.events).toEqual([
			{ type: "update", update: { kind: "agent_message_chunk", text: "one" } },
		]);
		expect(second.events).toEqual([
			{ type: "update", update: { kind: "agent_message_chunk", text: "two" } },
		]);
	});
});

describe("permission policy plumbing", () => {
	it("is read for the session being created, not once per router", async () => {
		const host = new FakeAcpHost();
		let reads = 0;
		const { caller } = makeCaller(host, () => {
			reads++;
			return "prompt";
		});

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		// A live pane short-circuits before the create, so it must not re-read
		// — the policy of a running session cannot change under it (B4's own
		// "applies to NEW sessions" note).
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		await caller.ensureSession({ paneId: "pane-2", cwd: "/repo" });

		expect(reads).toBe(2);
	});

	it("defaults to auto-approve when the app injects no reader", async () => {
		// This module is unit-tested without Electron, so the default here is
		// what a missing injection silently becomes — and it must match the
		// settings column's own default rather than opening every pane on prompt.
		const host = new FakeAcpHost();
		const created: string[] = [];
		// biome-ignore lint/suspicious/noExplicitAny: narrow fake, as above
		const spyHost = host as any;
		const original = spyHost.createSession.bind(host);
		spyHost.createSession = (options: { permissionPolicy?: string }) => {
			created.push(options.permissionPolicy ?? "MISSING");
			return original(options);
		};
		const { caller } = makeCaller(host);

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		expect(created).toEqual(["auto-approve"]);
	});
});

/** Let the router's async resolver run up to its `createSession` call. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// =============================================================================

describe("the buffer's two silent-loss holes (A7)", () => {
	it("re-banks a live session's events after the LAST subscriber detaches", async () => {
		// The teardown used to install nothing, so a pane that unmounted while
		// its session stayed alive emitted into zero listeners. Nothing counted
		// those, so the next attach could not tell a quiet agent from a lost one.
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const first = await subscribe(appRouter, "pane-1");
		first.subscription.unsubscribe();

		for (let index = 0; index < 3; index++) {
			host.emit("update:pane-1", {
				kind: "agent_message_chunk",
				text: `while-away-${index}`,
			});
		}

		const second = await subscribe(appRouter, "pane-1");

		expect(second.events).toEqual([
			{
				type: "update",
				update: { kind: "agent_message_chunk", text: "while-away-0" },
			},
			{
				type: "update",
				update: { kind: "agent_message_chunk", text: "while-away-1" },
			},
			{
				type: "update",
				update: { kind: "agent_message_chunk", text: "while-away-2" },
			},
		]);
		// The first subscriber saw nothing: everything arrived after it left.
		expect(first.events).toHaveLength(0);
	});

	it("counts what overran the re-installed buffer instead of dropping it silently", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const first = await subscribe(appRouter, "pane-1");
		first.subscription.unsubscribe();
		for (let index = 0; index < 5002; index++) {
			host.emit("update:pane-1", {
				kind: "agent_message_chunk",
				text: `chunk-${index}`,
			});
		}

		const second = await subscribe(appRouter, "pane-1");

		expect(second.events[0]).toEqual({ type: "events_dropped", count: 2 });
	});

	it("keeps buffering only while the pane is unsubscribed", async () => {
		// The re-install is a stand-in for a listener that is not there. Once one
		// attaches, traffic must pass straight through — a buffer that survived
		// the attach would swallow the live stream.
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const first = await subscribe(appRouter, "pane-1");
		first.subscription.unsubscribe();
		const second = await subscribe(appRouter, "pane-1");
		host.emit("update:pane-1", { kind: "agent_message_chunk", text: "live" });

		expect(second.events).toEqual([
			{ type: "update", update: { kind: "agent_message_chunk", text: "live" } },
		]);
	});

	it("does not re-bank for a pane whose session is gone", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		const first = await subscribe(appRouter, "pane-1");
		await caller.dispose({ paneId: "pane-1" });
		first.subscription.unsubscribe();

		host.emit("update:pane-1", { kind: "agent_message_chunk", text: "ghost" });
		const second = await subscribe(appRouter, "pane-1");

		expect(second.events).toHaveLength(0);
	});

	it("a second ensureSession mid-startup does NOT wipe the banked replay", async () => {
		// `AcpPane` is lazy and idempotent-by-`getSessionInfo`, which answers
		// nothing while the first create is still in flight — so a StrictMode
		// double mount lands two `attachBridge` calls around a `session/load`
		// whose whole history is already in the buffer.
		const host = new FakeAcpHost();
		const releases: Array<() => void> = [];
		// biome-ignore lint/suspicious/noExplicitAny: narrow fake, as above
		const spyHost = host as any;
		const original = spyHost.createSession.bind(host);
		spyHost.createSession = (options: { paneId: string }) =>
			new Promise((resolve) => {
				releases.push(() => resolve(original(options)));
			});
		const { router: appRouter, caller } = makeCaller(host);

		const firstCreate = caller.ensureSession({
			paneId: "pane-1",
			cwd: "/repo",
		});
		await tick();
		for (let index = 0; index < 3; index++) {
			host.emit("update:pane-1", {
				kind: "user_message_chunk",
				text: `replayed-${index}`,
			});
		}
		const secondCreate = caller.ensureSession({
			paneId: "pane-1",
			cwd: "/repo",
		});
		await tick();
		for (const release of releases) release();
		await Promise.all([firstCreate, secondCreate]);

		const { events } = await subscribe(appRouter, "pane-1");

		expect(events.map((event) => event.type)).toEqual([
			"update",
			"update",
			"update",
		]);
	});

	it("a second ensureSession mid-startup does NOT zero the drop counter", async () => {
		const host = new FakeAcpHost();
		const releases: Array<() => void> = [];
		// biome-ignore lint/suspicious/noExplicitAny: narrow fake, as above
		const spyHost = host as any;
		const original = spyHost.createSession.bind(host);
		spyHost.createSession = (options: { paneId: string }) =>
			new Promise((resolve) => {
				releases.push(() => resolve(original(options)));
			});
		const { router: appRouter, caller } = makeCaller(host);

		const firstCreate = caller.ensureSession({
			paneId: "pane-1",
			cwd: "/repo",
		});
		await tick();
		for (let index = 0; index < 5003; index++) {
			host.emit("update:pane-1", {
				kind: "agent_message_chunk",
				text: `chunk-${index}`,
			});
		}
		const secondCreate = caller.ensureSession({
			paneId: "pane-1",
			cwd: "/repo",
		});
		await tick();
		for (const release of releases) release();
		await Promise.all([firstCreate, secondCreate]);

		const { events } = await subscribe(appRouter, "pane-1");

		// Zeroing it is worse than the drop: a truncated replay then reads as a
		// complete one.
		expect(events[0]).toEqual({ type: "events_dropped", count: 3 });
	});

	it("throws the backlog away when the session EXITS, not only on dispose", async () => {
		// Symmetry with dispose (A11/F8). What a dead child banked describes a
		// conversation that is over; replaying it into the next generation's
		// pane would read as the new session having already spoken.
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		host.emit("update:pane-1", { kind: "agent_message_chunk", text: "old" });
		host.emit("exit:pane-1", { code: 0, signal: null, expected: true });

		const { events } = await subscribe(appRouter, "pane-1");

		expect(events).toHaveLength(0);
	});

	it("a LIVE subscriber still sees the exit before the backlog is dropped", async () => {
		// The control for the test above: dropping the buffer must not eat the
		// exit event itself for a pane that is actually listening.
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		const { events } = await subscribe(appRouter, "pane-1");

		host.emit("exit:pane-1", { code: 2, signal: null, expected: false });

		expect(events).toEqual([
			{ type: "session_exit", code: 2, signal: null, expected: false },
		]);
	});
});
