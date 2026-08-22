/**
 * Phase 6 gate 1, in full: the wire-level claims the design makes about a
 * durable restore and about a request parked on a human.
 *
 * Independent of `acp-durable.test.ts`, which is the builder's own smoke pass
 * — that file proves each mechanism exists. This one proves the properties the
 * gate is written in terms of: that a replay arrives IN ORDER and complete,
 * that the load resends the SAME parameters `session/new` would have got
 * (fingerprint discipline — an adapter tears the session down otherwise), that
 * every way a parked request can die settles it with the protocol's own
 * "the human did not answer", and that the auto-approve path really is silent
 * over the very same wire traffic that raises an event under `prompt`.
 *
 * Everything runs through `FakeAcpChild`'s real streams and the real SDK, so
 * the only fake part is who is on the other end of the wire.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { AcpSession, type AcpSessionHandlers } from "./acp-session";
import { setAcpBinaryPathResolver } from "./binary-resolver";
import {
	FakeAcpChild,
	FIXTURE_SESSION_ID,
	fixtureReplayHistory,
	fixtureToolCallSequence,
} from "./fake-acp-child";
import type {
	AcpPendingElicitation,
	AcpPendingPermission,
	AcpSessionOptions,
	AcpSessionUpdate,
} from "./types";

setAcpBinaryPathResolver(() => "/fake/claude-agent-acp/index.js");

interface Recorded {
	updates: AcpSessionUpdate[];
	permissions: AcpPendingPermission[];
	elicitations: AcpPendingElicitation[];
	errors: Error[];
	handlers: AcpSessionHandlers;
}

function recorder(): Recorded {
	const updates: AcpSessionUpdate[] = [];
	const permissions: AcpPendingPermission[] = [];
	const elicitations: AcpPendingElicitation[] = [];
	const errors: Error[] = [];
	return {
		updates,
		permissions,
		elicitations,
		errors,
		handlers: {
			onUpdate: (update) => updates.push(update),
			onError: (error) => errors.push(error),
			onExit: () => {},
			onPermissionRequest: (req) => permissions.push(req),
			onElicitationRequest: (req) => elicitations.push(req),
		},
	};
}

function sessionFor(
	child: FakeAcpChild,
	recorded: Recorded,
	options: Partial<AcpSessionOptions> = {},
): AcpSession {
	return new AcpSession(
		{
			paneId: "pane-1",
			cwd: process.cwd(),
			spawnProcess: child.spawnProcess,
			...options,
		},
		recorded.handlers,
	);
}

/** The permission request the adapter sends, as one call the tests reuse. */
function permissionRequest(child: FakeAcpChild): Promise<unknown> {
	return child.request("session/request_permission", {
		sessionId: child.sessionId,
		toolCall: {
			toolCallId: "toolu_1",
			title: "Write beta.txt",
			_meta: { claudeCode: { toolName: "Write" } },
		},
		options: [
			{ optionId: "allow", name: "Allow", kind: "allow_once" },
			{ optionId: "reject", name: "Reject", kind: "reject_once" },
		],
	});
}

/** A one-question `AskUserQuestion` form, the shape the adapter really builds. */
function elicitationRequest(child: FakeAcpChild): Promise<unknown> {
	return child.request("elicitation/create", {
		mode: "form",
		sessionId: child.sessionId,
		toolCallId: "toolu_ask",
		message: "Which approach?",
		requestedSchema: {
			type: "object",
			properties: {
				question_0: {
					type: "string",
					title: "Approach",
					oneOf: [
						{ const: "Rewrite", title: "Rewrite" },
						{ const: "Patch", title: "Patch" },
					],
				},
			},
		},
	});
}

/**
 * A replay long enough that an out-of-order or dropped frame cannot hide in
 * it, and whose every frame is individually identifiable.
 */
function numberedReplay(count: number): SessionUpdate[] {
	return Array.from({ length: count }, (_unused, index) => ({
		sessionUpdate: "agent_message_chunk" as const,
		content: { type: "text" as const, text: `chunk-${index}` },
	}));
}

let recorded: Recorded;

beforeEach(() => {
	recorded = recorder();
});

// =============================================================================
// Gate 1 — the replay itself
// =============================================================================

describe("gate 1 — session/load replay determinism", () => {
	it("delivers the scripted history IN ORDER, whole, with nothing extra", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			resumeSessionId: FIXTURE_SESSION_ID,
		});

		await session.start();

		// The fixture's own order, spelled out. A membership assertion (the
		// builder's) passes on a replay that arrived scrambled, and a scrambled
		// tool-call sequence renders a completed card as pending.
		expect(recorded.updates.map((update) => update.kind)).toEqual([
			"user_message_chunk",
			"agent_message_chunk",
			"tool_call",
			"tool_call_update",
			"tool_call_update",
			"tool_call_update",
			"tool_call_update",
			"agent_message_chunk",
		]);
		expect(recorded.updates).toHaveLength(fixtureReplayHistory().length);
		expect(recorded.errors).toHaveLength(0);

		await session.dispose();
	});

	it("keeps a long replay in order — every frame, once, in sequence", async () => {
		const child = new FakeAcpChild({ loadReplay: numberedReplay(200) });
		const session = sessionFor(child, recorded, {
			resumeSessionId: FIXTURE_SESSION_ID,
		});

		await session.start();

		expect(
			recorded.updates.map((update) =>
				update.kind === "agent_message_chunk" ? update.text : update.kind,
			),
		).toEqual(numberedReplay(200).map((_unused, index) => `chunk-${index}`));

		await session.dispose();
	});

	it("carries the tool-call lifecycle through unflattened", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			resumeSessionId: FIXTURE_SESSION_ID,
		});

		await session.start();

		// The replayed card must be reconstructible: the opening frame's id and
		// the closing frame's status both have to survive the mapper, or a
		// finished tool renders as one still running.
		const toolFrames = recorded.updates.filter(
			(update) =>
				update.kind === "tool_call" || update.kind === "tool_call_update",
		);
		expect(toolFrames).toHaveLength(fixtureToolCallSequence().length);
		const first = toolFrames[0];
		const last = toolFrames[toolFrames.length - 1];
		expect(first?.kind === "tool_call" ? first.toolCall.toolCallId : null).toBe(
			"toolu_fixture_edit",
		);
		expect(
			last?.kind === "tool_call_update" ? last.toolCall.status : null,
		).toBe("completed");

		await session.dispose();
	});

	it("resends the SAME session params session/new would have got", async () => {
		// Fingerprint discipline (design ground truth 2): the adapter tears the
		// session down when a load's params do not byte-match. Nothing else in
		// the suite reads what actually went out on the load frame.
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			resumeSessionId: FIXTURE_SESSION_ID,
		});
		await session.start();

		const load = child.framesFor("session/load")[0];
		expect(load?.params).toMatchObject({
			sessionId: FIXTURE_SESSION_ID,
			cwd: process.cwd(),
			mcpServers: [],
		});

		await session.dispose();

		// The control: the same session started fresh sends those same values to
		// `session/new`, which is what makes "the same object" a real claim.
		const fresh = new FakeAcpChild();
		const freshSession = sessionFor(fresh, recorder());
		await freshSession.start();
		expect(fresh.framesFor("session/new")[0]?.params).toMatchObject({
			cwd: process.cwd(),
			mcpServers: [],
		});
		await freshSession.dispose();
	});

	it("loads a session with no history without inventing one", async () => {
		const child = new FakeAcpChild({ loadReplay: [] });
		const session = sessionFor(child, recorded, {
			resumeSessionId: FIXTURE_SESSION_ID,
		});

		const info = await session.start();

		expect(info.restored).toBe("replayed");
		expect(recorded.updates).toHaveLength(0);

		await session.dispose();
	});

	it("does not attempt a load at all without a stored id", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded);

		const info = await session.start();

		expect(child.sentMethods()).not.toContain("session/load");
		expect(info.restored).toBe("fresh");

		await session.dispose();
	});
});

describe("gate 1 — fallback to fresh", () => {
	it("resourceNotFound yields a WORKING fresh session and replays nothing", async () => {
		const child = new FakeAcpChild({
			loadSessionError: { code: -32002, message: "unknown session" },
		});
		const session = sessionFor(child, recorded, {
			resumeSessionId: "acp-session-long-gone",
		});

		const info = await session.start();

		expect(info.restored).toBe("fresh");
		expect(info.state).toBe("ready");
		// The id the pane must persist is the NEW one, not the dead one it asked
		// for — writing the stale id back would make the failure permanent.
		expect(info.acpSessionId).toBe(FIXTURE_SESSION_ID);
		expect(info.acpSessionId).not.toBe("acp-session-long-gone");
		// A fresh fallback has nothing to replay. An update here would mean the
		// pane shows a conversation it is also calling new.
		expect(recorded.updates).toHaveLength(0);

		await session.dispose();
	});

	it("a fingerprint-matched load returns replayed — the positive control", async () => {
		// Same assertion target as the test above, opposite input, so "fresh"
		// is proved to be a verdict rather than the only value this field takes.
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			resumeSessionId: FIXTURE_SESSION_ID,
		});

		const info = await session.start();

		expect(info.restored).toBe("replayed");
		expect(recorded.updates.length).toBeGreaterThan(0);

		await session.dispose();
	});

	it("an agent that cannot load reports fresh and still starts", async () => {
		const child = new FakeAcpChild({ supportsLoadSession: false });
		const session = sessionFor(child, recorded, {
			resumeSessionId: FIXTURE_SESSION_ID,
		});

		const info = await session.start();

		expect(info.restored).toBe("fresh");
		expect(info.state).toBe("ready");
		expect(child.sentMethods()).not.toContain("session/load");
		expect(child.sentMethods()).toContain("session/new");

		await session.dispose();
	});
});

// =============================================================================
// A4 / A5 — every way a parked request can end
// =============================================================================

describe("parked requests are settled, never hung", () => {
	/**
	 * Park a request the way the adapter really does: inside a turn.
	 *
	 * `AcpSession.cancel()` is a no-op unless the session is `prompting` — a
	 * permission request only ever exists during a turn, so a test that raises
	 * one on an idle session is cancelling nothing and would pass against a
	 * build that had no settle logic at all.
	 */
	async function inTurn(
		session: AcpSession,
		raise: () => Promise<unknown>,
	): Promise<{ pending: Promise<unknown> }> {
		const turn = session.prompt("do the thing");
		// The turn's own promise outlives the cancel; nothing here awaits it.
		turn.catch(() => {});
		await Bun.sleep(5);
		// Wrapped, not returned bare: `await` on a promise that resolves to a
		// promise flattens both, which would await the parked request itself —
		// the one thing this helper exists to leave waiting.
		const pending = raise();
		await Bun.sleep(10);
		return { pending };
	}

	it("a turn cancel cancels a pending permission", async () => {
		// The design names turn cancel and session death as the ONLY two things
		// that end a parked request. The builder's suite covers teardown; cancel
		// is the half a user actually reaches, by pressing stop.
		const child = new FakeAcpChild({ autoRespondPrompt: false });
		const session = sessionFor(child, recorded, {
			permissionPolicy: "prompt",
		});
		await session.start();

		const { pending } = await inTurn(session, () => permissionRequest(child));
		expect(recorded.permissions).toHaveLength(1);

		await session.cancel();

		expect(await pending).toEqual({ outcome: { outcome: "cancelled" } });

		await session.dispose();
	});

	it("a turn cancel cancels a pending elicitation", async () => {
		const child = new FakeAcpChild({ autoRespondPrompt: false });
		const session = sessionFor(child, recorded, {
			permissionPolicy: "prompt",
		});
		await session.start();

		const { pending } = await inTurn(session, () => elicitationRequest(child));
		expect(recorded.elicitations).toHaveLength(1);

		await session.cancel();

		// `cancel` is elicitation's own word for it — a JSON-RPC error here
		// would read to the agent as a broken client rather than a silent human.
		expect(await pending).toEqual({ action: "cancel" });

		await session.dispose();
	});

	/**
	 * On a CRASH the settle is host-side only, and deliberately so: the session
	 * resolves the parked promise with `cancelled`, then closes the connection
	 * in the same tick, so the response never reaches a child that is already
	 * gone. What the pane needs is the state — the id released, no promise left
	 * waiting on a human who can no longer be asked — and that is what these
	 * two assert. Asserting the wire answer instead would demand a write to a
	 * dead process.
	 */
	it("the child dying releases a pending permission", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			permissionPolicy: "prompt",
		});
		await session.start();

		void permissionRequest(child);
		await Bun.sleep(10);
		const requestId = recorded.permissions[0]?.requestId ?? "";
		expect(requestId).not.toBe("");

		// Not a dispose: the adapter crashing, which is the case where nobody
		// asked for a teardown.
		child.exit(1, null);
		await Bun.sleep(10);

		expect(() => session.answerPermission(requestId, "allow")).toThrow(
			/acp-request-not-found/,
		);
		// The crash was reported rather than swallowed into a quiet no-op.
		expect(recorded.errors.map((error) => error.message).join("\n")).toMatch(
			/acp-session-died/,
		);
	});

	it("the child dying releases a pending elicitation", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			permissionPolicy: "prompt",
		});
		await session.start();

		void elicitationRequest(child);
		await Bun.sleep(10);
		const requestId = recorded.elicitations[0]?.requestId ?? "";
		expect(requestId).not.toBe("");

		child.exit(1, null);
		await Bun.sleep(10);

		expect(() =>
			session.answerElicitation(requestId, { action: "decline" }),
		).toThrow(/acp-request-not-found/);
	});

	it("a cancelled request's id is spent — a late click cannot resurrect it", async () => {
		const child = new FakeAcpChild({ autoRespondPrompt: false });
		const session = sessionFor(child, recorded, {
			permissionPolicy: "prompt",
		});
		await session.start();

		await inTurn(session, () => permissionRequest(child));
		const requestId = recorded.permissions[0]?.requestId ?? "";
		expect(requestId).not.toBe("");

		await session.cancel();

		expect(() => session.answerPermission(requestId, "allow")).toThrow(
			/acp-request-not-found/,
		);

		await session.dispose();
	});

	it("an IDLE cancel settles nothing — the request is still answerable", async () => {
		// The boundary the guard in `cancel()` draws, asserted so the tests above
		// cannot be read as "any cancel call settles everything". A request that
		// somehow exists outside a turn still belongs to a live human.
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			permissionPolicy: "prompt",
		});
		await session.start();

		const pending = permissionRequest(child);
		await Bun.sleep(10);
		const requestId = recorded.permissions[0]?.requestId ?? "";

		await session.cancel();

		session.answerPermission(requestId, "allow");
		expect(await pending).toEqual({
			outcome: { outcome: "selected", optionId: "allow" },
		});

		await session.dispose();
	});

	it("an unknown requestId is refused with the same coded error", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			permissionPolicy: "prompt",
		});
		await session.start();

		expect(() => session.answerPermission("perm-never", "allow")).toThrow(
			/acp-request-not-found/,
		);
		expect(() =>
			session.answerElicitation("elicit-never", { action: "decline" }),
		).toThrow(/acp-request-not-found/);

		await session.dispose();
	});

	it("refuses an elicitation answer naming a field the form never declared", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			permissionPolicy: "prompt",
		});
		await session.start();

		void elicitationRequest(child);
		await Bun.sleep(10);
		const requestId = recorded.elicitations[0]?.requestId ?? "";

		expect(() =>
			session.answerElicitation(requestId, {
				action: "accept",
				content: { question_9: "Rewrite" },
			}),
		).toThrow(/acp-invalid-request-answer/);

		// PROVES THE GATE FIRES ON THE RIGHT AXIS: the declared field is
		// accepted over the same wire, so the throw above is about the key and
		// not about answering at all.
		session.answerElicitation(requestId, {
			action: "accept",
			content: { question_0: "Rewrite" },
		});

		await session.dispose();
	});
});

describe("permission policy", () => {
	it("auto-approve emits nothing over the SAME wire traffic prompt raises an event on", async () => {
		// One fixture, two policies. Asserting only the silent half would pass
		// for a build where the request never reached the host at all.
		const autoChild = new FakeAcpChild();
		const autoRecorded = recorder();
		const autoSession = sessionFor(autoChild, autoRecorded, {
			permissionPolicy: "auto-approve",
		});
		await autoSession.start();
		const autoOutcome = await permissionRequest(autoChild);

		expect(autoRecorded.permissions).toHaveLength(0);
		expect(autoOutcome).toEqual({
			outcome: { outcome: "selected", optionId: "allow" },
		});
		await autoSession.dispose();

		const promptChild = new FakeAcpChild();
		const promptRecorded = recorder();
		const promptSession = sessionFor(promptChild, promptRecorded, {
			permissionPolicy: "prompt",
		});
		await promptSession.start();
		const promptPending = permissionRequest(promptChild);
		await Bun.sleep(10);

		expect(promptRecorded.permissions).toHaveLength(1);
		promptSession.answerPermission(
			promptRecorded.permissions[0]?.requestId ?? "",
			"reject",
		);
		expect(await promptPending).toEqual({
			outcome: { outcome: "selected", optionId: "reject" },
		});
		await promptSession.dispose();
	});

	it("defaults to auto-approve when no policy is given", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded);
		await session.start();

		await permissionRequest(child);

		expect(recorded.permissions).toHaveLength(0);

		await session.dispose();
	});
});
