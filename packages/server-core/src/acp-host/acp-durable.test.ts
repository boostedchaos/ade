/**
 * Phase 6 Lane A smoke: durable restore (A1) and the human-paced requests
 * (A4/A5), driven over `FakeAcpChild`'s real streams and the real SDK.
 *
 * Deliberately thin — the phase's full suite is authored independently. What
 * is here is the handful of claims that cannot be read off the code: that a
 * load really replays through the ordinary update path, that a rejected id
 * really degrades to a working session instead of failing the pane, and that
 * a request parked on a human really does come back off the wire.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { AcpSession, type AcpSessionHandlers } from "./acp-session";
import { setAcpBinaryPathResolver } from "./binary-resolver";
import { normalizeElicitationRequest } from "./elicitation";
import {
	FakeAcpChild,
	FIXTURE_SESSION_ID,
	fixtureReplayHistory,
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
	handlers: AcpSessionHandlers;
}

function recorder(): Recorded {
	const updates: AcpSessionUpdate[] = [];
	const permissions: AcpPendingPermission[] = [];
	const elicitations: AcpPendingElicitation[] = [];
	return {
		updates,
		permissions,
		elicitations,
		handlers: {
			onUpdate: (update) => updates.push(update),
			onError: () => {},
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

let recorded: Recorded;

beforeEach(() => {
	recorded = recorder();
});

describe("A1 — session/load", () => {
	it("replays the stored conversation and reports restored: replayed", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			resumeSessionId: FIXTURE_SESSION_ID,
		});

		const info = await session.start();

		expect(info.restored).toBe("replayed");
		expect(info.acpSessionId).toBe(FIXTURE_SESSION_ID);
		// Loaded, not created: a `session/new` here would silently start an
		// empty conversation while reporting a restore.
		expect(child.sentMethods()).toContain("session/load");
		expect(child.sentMethods()).not.toContain("session/new");

		// The replay came through the ORDINARY update path, user turn included
		// — which is the whole of A3's reason to exist.
		const kinds = recorded.updates.map((update) => update.kind);
		expect(kinds).toContain("user_message_chunk");
		expect(kinds).toContain("tool_call");
		expect(recorded.updates).toContainEqual({
			kind: "user_message_chunk",
			text: "edit beta.txt for me",
		});
		expect(kinds.filter((kind) => kind === "unknown")).toHaveLength(0);
		// Every scripted frame arrived, so nothing was dropped in the window
		// between the request going out and the response coming back.
		expect(recorded.updates).toHaveLength(fixtureReplayHistory().length);

		await session.dispose();
	});

	it.each([
		["resourceNotFound", -32002],
		["invalidParams", -32602],
	])("falls back to a fresh session on %s", async (_label, code) => {
		const child = new FakeAcpChild({
			loadSessionError: { code, message: "nope" },
		});
		const session = sessionFor(child, recorded, {
			resumeSessionId: "acp-session-long-gone",
		});

		const info = await session.start();

		// A working session either way — the failure is REPORTED, not raised.
		expect(info.restored).toBe("fresh");
		expect(info.state).toBe("ready");
		expect(info.acpSessionId).toBe(FIXTURE_SESSION_ID);
		expect(child.sentMethods()).toContain("session/load");
		expect(child.sentMethods()).toContain("session/new");

		await session.dispose();
	});

	it("fails the startup on a code that is NOT a fallback", async () => {
		// -32603 is an internal error: the agent is broken, not forgetful.
		// Degrading to a new session here would hide a real fault behind a
		// working-looking pane.
		const child = new FakeAcpChild({
			loadSessionError: { code: -32603, message: "boom" },
		});
		const session = sessionFor(child, recorded, {
			resumeSessionId: FIXTURE_SESSION_ID,
		});

		await expect(session.start()).rejects.toThrow(/session\/load failed/);
	});

	it("skips the load when the agent cannot do it", async () => {
		const child = new FakeAcpChild({ supportsLoadSession: false });
		const session = sessionFor(child, recorded, {
			resumeSessionId: FIXTURE_SESSION_ID,
		});

		const info = await session.start();

		expect(info.restored).toBe("fresh");
		// Not even attempted: a `methodNotFound` is not a fallback code, so
		// trying anyway would fail the whole startup.
		expect(child.sentMethods()).not.toContain("session/load");

		await session.dispose();
	});

	it("reports restored: fresh for an ordinary new session", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded);

		expect((await session.start()).restored).toBe("fresh");

		await session.dispose();
	});
});

describe("A4 — permission requests", () => {
	it("emits nothing under auto-approve", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded);
		await session.start();

		const outcome = await child.request("session/request_permission", {
			sessionId: child.sessionId,
			toolCall: { toolCallId: "toolu_1", title: "Write beta.txt" },
			options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
		});

		expect(outcome).toEqual({
			outcome: { outcome: "selected", optionId: "allow" },
		});
		expect(recorded.permissions).toHaveLength(0);

		await session.dispose();
	});

	it("parks the request under prompt and answers it off the wire", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			permissionPolicy: "prompt",
		});
		await session.start();

		const pending = child.request("session/request_permission", {
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

		// No timer anywhere: it waits exactly as long as the human does.
		await Bun.sleep(10);
		expect(recorded.permissions).toHaveLength(1);
		const request = recorded.permissions[0];
		expect(request?.title).toBe("Write beta.txt");
		expect(request?.toolName).toBe("Write");

		session.answerPermission(request?.requestId ?? "", "reject");
		expect(await pending).toEqual({
			outcome: { outcome: "selected", optionId: "reject" },
		});

		// The id is spent, and a second click must say so rather than throw
		// something the caller cannot classify.
		expect(() =>
			session.answerPermission(request?.requestId ?? "", "allow"),
		).toThrow(/acp-request-not-found/);

		await session.dispose();
	});

	it("cancels a parked request when the session is torn down", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			permissionPolicy: "prompt",
		});
		await session.start();

		const pending = child.request("session/request_permission", {
			sessionId: child.sessionId,
			toolCall: { toolCallId: "toolu_1", title: "Write beta.txt" },
			options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
		});
		await Bun.sleep(10);
		expect(recorded.permissions).toHaveLength(1);

		await session.dispose();

		// Settled, not left hanging and not rejected: "cancelled" is the
		// protocol's own word for a human who never answered.
		expect(await pending).toEqual({ outcome: { outcome: "cancelled" } });
	});

	it("refuses an option the request never offered", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded, {
			permissionPolicy: "prompt",
		});
		await session.start();

		void child.request("session/request_permission", {
			sessionId: child.sessionId,
			toolCall: { toolCallId: "toolu_1", title: "Write beta.txt" },
			options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
		});
		await Bun.sleep(10);

		expect(() =>
			session.answerPermission(
				recorded.permissions[0]?.requestId ?? "",
				"allow_always",
			),
		).toThrow(/acp-invalid-request-answer/);

		await session.dispose();
	});
});

/**
 * The exact request `claude-agent-acp` 0.63.0 builds for a one-question
 * `AskUserQuestion` (`elicitation.js:108-154`) — transcribed from the adapter
 * rather than invented, because a form shape we guessed at would test our own
 * misreading of the contract.
 */
function askUserQuestionRequest(sessionId: string): CreateElicitationRequest {
	return {
		mode: "form",
		sessionId,
		toolCallId: "toolu_ask",
		message: "Which approach?",
		requestedSchema: {
			type: "object",
			properties: {
				question_0: {
					type: "string",
					title: "Approach",
					oneOf: [
						{ const: "Rewrite", title: "Rewrite", description: "Start over" },
						{ const: "Patch", title: "Patch" },
					],
				},
				question_0_custom: {
					type: "string",
					title: "Other",
					description:
						"Type your own answer instead of choosing an option above (optional).",
				},
			},
		},
	};
}

describe("A5 — elicitation", () => {
	it("normalizes the adapter's real AskUserQuestion form", () => {
		const form = normalizeElicitationRequest(
			askUserQuestionRequest("session-1"),
		);

		expect(form).toEqual({
			fields: [
				{
					key: "question_0",
					kind: "select",
					title: "Approach",
					required: false,
					options: [
						{ value: "Rewrite", label: "Rewrite", description: "Start over" },
						{ value: "Patch", label: "Patch" },
					],
				},
				{
					key: "question_0_custom",
					kind: "text",
					title: "Other",
					description:
						"Type your own answer instead of choosing an option above (optional).",
					required: false,
				},
			],
		});
	});

	it("refuses a form it cannot draw, rather than half-drawing it", () => {
		expect(
			normalizeElicitationRequest({
				mode: "form",
				sessionId: "session-1",
				message: "How many?",
				requestedSchema: {
					type: "object",
					properties: { count: { type: "integer", title: "Count" } },
				},
			}),
		).toBeNull();

		// A mode we never advertised.
		expect(
			normalizeElicitationRequest({
				mode: "url",
				sessionId: "session-1",
				elicitationId: "e1",
				url: "https://example.com",
				message: "Sign in",
			}),
		).toBeNull();
	});

	it("parks a renderable form and returns the answer to the agent", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded);
		await session.start();

		const pending = child.request(
			"elicitation/create",
			askUserQuestionRequest(child.sessionId) as unknown as Record<
				string,
				unknown
			>,
		);
		await Bun.sleep(10);

		expect(recorded.elicitations).toHaveLength(1);
		const request = recorded.elicitations[0];
		expect(request?.message).toBe("Which approach?");

		session.answerElicitation(request?.requestId ?? "", {
			action: "accept",
			content: { question_0: "Patch" },
		});

		expect(await pending).toEqual({
			action: "accept",
			content: { question_0: "Patch" },
		});

		await session.dispose();
	});

	it("declines an unrenderable form instead of hanging", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded);
		await session.start();

		const outcome = await child.request("elicitation/create", {
			mode: "form",
			sessionId: child.sessionId,
			message: "How many?",
			requestedSchema: {
				type: "object",
				properties: { count: { type: "integer" } },
			},
		});

		// A decline lets the agent carry on with empty answers; a hang would
		// stall the turn forever and an error would read as a broken client.
		expect(outcome).toEqual({ action: "decline" });
		expect(recorded.elicitations).toHaveLength(0);

		await session.dispose();
	});

	it("advertises elicitation.form in initialize", async () => {
		const child = new FakeAcpChild();
		const session = sessionFor(child, recorded);
		await session.start();

		// Without this the adapter puts AskUserQuestion in `disallowedTools`
		// and the agent cannot ask a multiple-choice question at all.
		const initialize = child.framesFor("initialize")[0];
		expect(
			(
				initialize?.params as {
					clientCapabilities?: { elicitation?: unknown };
				}
			)?.clientCapabilities?.elicitation,
		).toEqual({ form: {} });

		await session.dispose();
	});
});
