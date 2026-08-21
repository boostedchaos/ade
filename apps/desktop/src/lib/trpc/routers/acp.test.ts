/**
 * ACP router behaviour, against an injected fake `AcpHost`.
 *
 * Every claim the design makes about this file is asserted here: idempotent
 * create, the synthetic turn boundary and its ordering, listener teardown, the
 * never-throws contracts — and the one thing the design got wrong, which is
 * that a subscription attached directly to the host goes deaf the moment a
 * session dies (see "survives a session death" below).
 */

import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type {
	AcpConfigOption,
	AcpConfigSnapshot,
	AcpSessionInfo,
	AcpSessionUpdate,
} from "@ade/server-core/acp-host";
import type { Unsubscribable } from "@trpc/server/observable";
import { type AcpPaneEvent, createAcpRouter } from "./acp";

// =============================================================================
// Fake host
// =============================================================================

function info(paneId: string, state: AcpSessionInfo["state"]): AcpSessionInfo {
	return {
		paneId,
		acpSessionId: `acp-${paneId}`,
		state,
		modes: null,
		configOptions: [],
		configSeq: 1,
		availableCommands: [],
	};
}

/**
 * A real EventEmitter, because the defect this suite exists to catch is about
 * listener lifetimes — including `AcpHost`'s own habit of removing all of a
 * pane's listeners when its session ends.
 */
class FakeAcpHost extends EventEmitter {
	sessions = new Map<string, AcpSessionInfo>();
	createCalls: { paneId: string; cwd: string; env?: Record<string, string> }[] =
		[];
	promptCalls: { paneId: string; text: string }[] = [];
	cancelCalls: string[] = [];
	disposeCalls: string[] = [];
	/** Set to make `prompt` reject. */
	promptError: Error | null = null;
	/** Updates the fake emits before `prompt` settles. */
	updatesDuringPrompt: AcpSessionUpdate[] = [];
	setConfigOptionCalls: {
		paneId: string;
		optionId: string;
		value: string;
		options: { allowUnlisted?: boolean };
	}[] = [];
	readConfigCalls: string[] = [];
	/** What the fake's read-back reports. The router's only source of truth. */
	readConfigResult: AcpConfigOption[] = [];
	/** Cache generation the read-back reports (A1). */
	readConfigSeq = 7;
	/**
	 * False for the case A2 exists for: `session/resume` answered without any
	 * `configOptions`, so the list is the cache's memory and nothing on the
	 * wire confirmed or refuted the write.
	 */
	readConfigFromWire = true;
	/** Set to make `setConfigOption` reject (the local gate refusing a write). */
	setConfigOptionError: Error | null = null;

	async setConfigOption(
		paneId: string,
		optionId: string,
		value: string,
		options: { allowUnlisted?: boolean } = {},
	): Promise<void> {
		this.setConfigOptionCalls.push({ paneId, optionId, value, options });
		if (this.setConfigOptionError) throw this.setConfigOptionError;
	}

	async readConfig(paneId: string): Promise<AcpConfigSnapshot> {
		this.readConfigCalls.push(paneId);
		return {
			options: this.readConfigResult,
			seq: this.readConfigSeq,
			fromWire: this.readConfigFromWire,
		};
	}

	createSession(options: {
		paneId: string;
		cwd: string;
		env?: Record<string, string>;
	}): Promise<AcpSessionInfo> {
		this.createCalls.push(options);
		const existing = this.sessions.get(options.paneId);
		if (existing) return Promise.resolve(existing);
		const created = info(options.paneId, "ready");
		this.sessions.set(options.paneId, created);
		return Promise.resolve(created);
	}

	async prompt(paneId: string, text: string): Promise<{ stopReason: string }> {
		this.promptCalls.push({ paneId, text });
		for (const update of this.updatesDuringPrompt) {
			this.emit(`update:${paneId}`, update);
		}
		await Promise.resolve();
		if (this.promptError) throw this.promptError;
		return { stopReason: "end_turn" };
	}

	async cancel(paneId: string): Promise<void> {
		this.cancelCalls.push(paneId);
	}

	async disposeSession(paneId: string): Promise<void> {
		this.disposeCalls.push(paneId);
		this.sessions.delete(paneId);
		this.removePaneListeners(paneId);
	}

	getSessionInfo(paneId: string): AcpSessionInfo | undefined {
		return this.sessions.get(paneId);
	}

	/** The real host does exactly this on exit AND on dispose. */
	removePaneListeners(paneId: string): void {
		this.removeAllListeners(`update:${paneId}`);
		this.removeAllListeners(`exit:${paneId}`);
		this.removeAllListeners(`error:${paneId}`);
	}

	/** Simulate the child dying, host-side, in the real order. */
	killSession(paneId: string, code = 1): void {
		this.sessions.delete(paneId);
		this.emit(`exit:${paneId}`, { code, signal: null, expected: false });
		this.removePaneListeners(paneId);
	}
}

function makeRouter(
	host: FakeAcpHost,
	childEnv?: () => Record<string, string>,
) {
	return createAcpRouter({
		// biome-ignore lint/suspicious/noExplicitAny: the fake implements the surface the router uses, not the whole AcpHost class
		host: host as any,
		childEnv: childEnv ?? (() => ({ CLAUDE_CODE_EXECUTABLE: "/fake/claude" })),
	});
}

type Caller = ReturnType<ReturnType<typeof makeRouter>["createCaller"]>;

function makeCaller(
	host: FakeAcpHost,
	childEnv?: () => Record<string, string>,
) {
	const appRouter = makeRouter(host, childEnv);
	return {
		router: appRouter,
		caller: appRouter.createCaller({}) as Caller,
	};
}

/** Subscribe to a pane and collect events; returns the collected array. */
async function subscribe(
	appRouter: ReturnType<typeof makeRouter>,
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

describe("ensureSession", () => {
	it("creates a session and passes the child env through", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);

		const result = await caller.ensureSession({
			paneId: "pane-1",
			cwd: "/repo",
		});

		expect(result.acpSessionId).toBe("acp-pane-1");
		expect(host.createCalls).toHaveLength(1);
		expect(host.createCalls[0]?.env).toEqual({
			CLAUDE_CODE_EXECUTABLE: "/fake/claude",
		});
	});

	it("short-circuits for a live session without spawning a second child", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		const second = await caller.ensureSession({
			paneId: "pane-1",
			cwd: "/repo",
		});

		expect(second.acpSessionId).toBe("acp-pane-1");
		expect(host.createCalls).toHaveLength(1);
	});

	it("rejects with the resolver's message when there is no Claude Code", async () => {
		// The design's hard requirement: a machine with no `claude` produces a
		// readable, attributable failure BEFORE the spawn — not a hang, and not a
		// silent fall back to a bundled CLI, because Phase 2 ships none.
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host, () => {
			throw new Error(
				"acp-claude-not-found: Claude Code was not found on this machine. " +
					"Install it with `npm i -g @anthropic-ai/claude-code`",
			);
		});

		let message = "";
		try {
			await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain("acp-claude-not-found");
		expect(message).toContain("@anthropic-ai/claude-code");
		expect(host.createCalls).toHaveLength(0);
	});

	it("rejects a paneId with path separators", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);
		await expect(
			caller.ensureSession({ paneId: "../evil", cwd: "/repo" }),
		).rejects.toThrow();
	});
});

describe("events subscription", () => {
	it("delivers host updates as `update` events", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		const { events } = await subscribe(appRouter, "pane-1");

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		host.emit("update:pane-1", { kind: "agent_message_chunk", text: "OK" });

		expect(events).toEqual([
			{
				type: "update",
				update: { kind: "agent_message_chunk", text: "OK" },
			},
		]);
	});

	it("can be subscribed BEFORE the session exists", async () => {
		// EventEmitter listeners attach fine against a pane with no session, so
		// the pane may subscribe and call ensureSession in either order.
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		const { events } = await subscribe(appRouter, "pane-late");

		await caller.ensureSession({ paneId: "pane-late", cwd: "/repo" });
		host.emit("update:pane-late", { kind: "agent_message_chunk", text: "hi" });

		expect(events).toHaveLength(1);
	});

	it("emits turn_end AFTER every update of that turn", async () => {
		const host = new FakeAcpHost();
		host.updatesDuringPrompt = [
			{ kind: "agent_message_chunk", text: "O" },
			{ kind: "agent_message_chunk", text: "K" },
		];
		const { router: appRouter, caller } = makeCaller(host);
		const { events } = await subscribe(appRouter, "pane-1");

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		await caller.prompt({ paneId: "pane-1", text: "reply with exactly: OK" });

		expect(events.map((e) => e.type)).toEqual(["update", "update", "turn_end"]);
		expect(events.at(-1)).toEqual({ type: "turn_end", stopReason: "end_turn" });
	});

	it("emits turn_error and rethrows when the prompt rejects", async () => {
		const host = new FakeAcpHost();
		host.promptError = new Error("acp-session-died: child exited");
		const { router: appRouter, caller } = makeCaller(host);
		const { events } = await subscribe(appRouter, "pane-1");

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		await expect(
			caller.prompt({ paneId: "pane-1", text: "hi" }),
		).rejects.toThrow("acp-session-died");

		expect(events).toEqual([
			{ type: "turn_error", message: "acp-session-died: child exited" },
		]);
	});

	it("maps a host exit to session_exit with its code and expectedness", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		const { events } = await subscribe(appRouter, "pane-1");

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		host.emit("exit:pane-1", { code: 3, signal: null, expected: false });

		expect(events).toEqual([
			{ type: "session_exit", code: 3, signal: null, expected: false },
		]);
	});

	it("maps a host error to session_error carrying the coded message", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		const { events } = await subscribe(appRouter, "pane-1");

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		host.emit("error:pane-1", new Error("acp-rpc-error: boom"));

		expect(events).toEqual([
			{ type: "session_error", message: "acp-rpc-error: boom" },
		]);
	});

	it("stops delivering after unsubscribe", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		const { events, subscription } = await subscribe(appRouter, "pane-1");

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		subscription.unsubscribe();
		host.emit("update:pane-1", { kind: "agent_message_chunk", text: "late" });

		expect(events).toHaveLength(0);
	});

	it("delivers to a fresh subscription after the old one tore down", async () => {
		// Teardown must remove only ITS OWN listener. A teardown that wiped the
		// pane's fan-out would leave a remounted pane permanently deaf.
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const first = await subscribe(appRouter, "pane-1");
		first.subscription.unsubscribe();
		const second = await subscribe(appRouter, "pane-1");
		host.emit("update:pane-1", { kind: "agent_message_chunk", text: "again" });

		expect(first.events).toHaveLength(0);
		expect(second.events).toHaveLength(1);
	});

	it("does not double-deliver when ensureSession runs twice", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		const { events } = await subscribe(appRouter, "pane-1");

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		host.emit("update:pane-1", { kind: "agent_message_chunk", text: "once" });

		expect(events).toHaveLength(1);
	});

	it("keeps other panes isolated", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		const one = await subscribe(appRouter, "pane-1");
		const two = await subscribe(appRouter, "pane-2");

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		await caller.ensureSession({ paneId: "pane-2", cwd: "/repo" });
		host.emit("update:pane-1", { kind: "agent_message_chunk", text: "mine" });

		expect(one.events).toHaveLength(1);
		expect(two.events).toHaveLength(0);
	});

	/**
	 * The design's D4 says the subscription attaches its listeners to the host
	 * directly. That cannot work: `AcpHost` calls `removePaneListeners(paneId)`
	 * when a session exits, so a direct listener is destroyed by the very event
	 * that tells the pane its session died — and D6's "New session" button then
	 * produces a live child whose every message is dropped. The router bridges
	 * host → a router-local emitter and re-installs the bridge in
	 * `ensureSession`, which is what this asserts.
	 */
	it("survives a session death and delivers the NEXT session's updates", async () => {
		const host = new FakeAcpHost();
		const { router: appRouter, caller } = makeCaller(host);
		const { events } = await subscribe(appRouter, "pane-1");

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		host.killSession("pane-1", 1);
		expect(events.map((e) => e.type)).toEqual(["session_exit"]);

		// "New session": the pane calls ensureSession again.
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		host.emit("update:pane-1", { kind: "agent_message_chunk", text: "alive" });

		expect(events.map((e) => e.type)).toEqual(["session_exit", "update"]);
	});
});

describe("cancel / dispose / state", () => {
	it("cancel forwards and never throws for an unknown pane", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);
		await expect(caller.cancel({ paneId: "ghost" })).resolves.toEqual({
			ok: true,
		});
		expect(host.cancelCalls).toEqual(["ghost"]);
	});

	it("dispose forwards, is idempotent, and detaches the host bridge", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);

		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		await caller.dispose({ paneId: "pane-1" });
		await caller.dispose({ paneId: "pane-1" });

		expect(host.disposeCalls).toEqual(["pane-1", "pane-1"]);
		expect(host.listenerCount("update:pane-1")).toBe(0);
		expect(host.listenerCount("exit:pane-1")).toBe(0);
		expect(host.listenerCount("error:pane-1")).toBe(0);
	});

	it("state returns null for a pane with no session", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);
		expect(await caller.state({ paneId: "ghost" })).toBeNull();
	});

	it("state returns the live session info", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });
		expect(await caller.state({ paneId: "pane-1" })).toMatchObject({
			paneId: "pane-1",
			state: "ready",
		});
	});
});

// =============================================================================
// Phase 4 — config write + read-back
// =============================================================================

function option(
	id: string,
	currentValue: string,
	values: { id: string; label?: string }[] = [],
): AcpConfigOption {
	return { id, name: id, currentValue, values };
}

describe("setConfigOption", () => {
	it("forwards paneId, configId, value and allowUnlisted to the host", async () => {
		const host = new FakeAcpHost();
		host.readConfigResult = [option("model", "haiku")];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		await caller.setConfigOption({
			paneId: "pane-1",
			configId: "model",
			value: "haiku",
			allowUnlisted: true,
		});

		expect(host.setConfigOptionCalls).toEqual([
			{
				paneId: "pane-1",
				optionId: "model",
				value: "haiku",
				options: { allowUnlisted: true },
			},
		]);
	});

	it("passes allowUnlisted through as undefined when the caller omits it", async () => {
		const host = new FakeAcpHost();
		host.readConfigResult = [option("effort", "high")];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		await caller.setConfigOption({
			paneId: "pane-1",
			configId: "effort",
			value: "high",
		});

		expect(host.setConfigOptionCalls[0]?.options).toEqual({
			allowUnlisted: undefined,
		});
	});

	it("ALWAYS reads back after the write, and returns the read-back list", async () => {
		// Not an optional confirmation: the write's own result carries no
		// information, so a mutation that skipped this would return a guess.
		const host = new FakeAcpHost();
		host.readConfigResult = [
			option("model", "haiku", [{ id: "haiku" }]),
			option("effort", "medium"),
		];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "model",
			value: "haiku",
		});

		expect(host.readConfigCalls).toEqual(["pane-1"]);
		expect(result.configOptions).toEqual(host.readConfigResult);
		// A1: the list is stamped, so the renderer can order it against the
		// update stream rather than trusting IPC arrival order.
		expect(result.seq).toBe(host.readConfigSeq);
	});

	it("verified:true when the read-back agrees with the request", async () => {
		const host = new FakeAcpHost();
		host.readConfigResult = [option("model", "claude-fable-5[1m]")];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "model",
			value: "claude-fable-5[1m]",
		});

		expect(result.applied).toEqual({
			configId: "model",
			requestedValue: "claude-fable-5[1m]",
			actualValue: "claude-fable-5[1m]",
			verified: true,
			unverified: false,
			canonicalized: false,
		});
	});

	it("verified:false when the adapter silently resolved it elsewhere", async () => {
		const host = new FakeAcpHost();
		// The write was answered GREEN; the read-back says `default`.
		host.readConfigResult = [option("model", "default")];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "model",
			value: "fabl-5-typo",
			allowUnlisted: true,
		});

		expect(result.applied).toEqual({
			configId: "model",
			requestedValue: "fabl-5-typo",
			actualValue: "default",
			verified: false,
			unverified: false,
			canonicalized: false,
		});
	});

	it("reports actualValue null (not verified) when the option vanished", async () => {
		// A model switch can remove `effort` outright; the read-back then has
		// nothing to report and the write must not read as confirmed.
		const host = new FakeAcpHost();
		host.readConfigResult = [option("model", "haiku")];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "effort",
			value: "high",
		});

		expect(result.applied.actualValue).toBeNull();
		expect(result.applied.verified).toBe(false);
	});

	it("propagates the local gate's rejection and never reads back", async () => {
		const host = new FakeAcpHost();
		host.setConfigOptionError = new Error("acp-invalid-config-value: nope");
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		await expect(
			caller.setConfigOption({
				paneId: "pane-1",
				configId: "effort",
				value: "ludicrous",
			}),
		).rejects.toThrow(/acp-invalid-config-value/);
		expect(host.readConfigCalls).toEqual([]);
	});

	it("rejects a paneId with path separators", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);

		await expect(
			caller.setConfigOption({
				paneId: "../etc",
				configId: "model",
				value: "haiku",
			}),
		).rejects.toThrow();
		expect(host.setConfigOptionCalls).toEqual([]);
	});
});

describe("readConfig", () => {
	it("forwards the paneId and returns the host's list", async () => {
		const host = new FakeAcpHost();
		host.readConfigResult = [
			option("model", "default", [{ id: "default", label: "Default" }]),
		];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const snapshot = await caller.readConfig({ paneId: "pane-1" });

		expect(host.readConfigCalls).toEqual(["pane-1"]);
		expect(snapshot.configOptions).toEqual(host.readConfigResult);
		expect(snapshot.seq).toBe(host.readConfigSeq);
	});

	it("hits the wire on every call — it must not be a cached query", async () => {
		const host = new FakeAcpHost();
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		await caller.readConfig({ paneId: "pane-1" });
		await caller.readConfig({ paneId: "pane-1" });

		expect(host.readConfigCalls).toEqual(["pane-1", "pane-1"]);
	});
});

// =============================================================================
// A2 — a read-back that confirmed nothing is not a green settle
// =============================================================================

describe("unverified read-back (A2)", () => {
	it("F2: a resume carrying no configOptions reports unverified, not verified", async () => {
		// `session/resume` answering without `configOptions` means the adapter
		// reported nothing this time. The cache's own last-known value then
		// happens to equal what we asked for whenever the previous write agreed
		// — which is how an unproven write came back `verified: true`.
		const host = new FakeAcpHost();
		host.readConfigResult = [option("model", "haiku")];
		host.readConfigFromWire = false;
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "model",
			value: "haiku",
		});

		expect(result.applied.unverified).toBe(true);
		expect(result.applied.verified).toBe(false);
	});

	it("POSITIVE CONTROL: the same values with a real wire read are verified", async () => {
		const host = new FakeAcpHost();
		host.readConfigResult = [option("model", "haiku")];
		host.readConfigFromWire = true;
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "model",
			value: "haiku",
		});

		expect(result.applied.unverified).toBe(false);
		expect(result.applied.verified).toBe(true);
	});

	it("an unverified read-back is never ALSO a substitution", async () => {
		// Two different claims: "the adapter applied something else" and "the
		// adapter did not say". Reporting both would show two chips for one
		// event, and the mismatch one would be a guess.
		const host = new FakeAcpHost();
		host.readConfigResult = [option("model", "default")];
		host.readConfigFromWire = false;
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "model",
			value: "haiku",
		});

		expect(result.applied.unverified).toBe(true);
		expect(result.applied.canonicalized).toBe(false);
	});

	it("readConfig reports it too, so a mount seed is not mistaken for proof", async () => {
		const host = new FakeAcpHost();
		host.readConfigFromWire = false;
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		expect((await caller.readConfig({ paneId: "pane-1" })).unverified).toBe(
			true,
		);
	});
});

// =============================================================================
// A4 — alias canonicalization is not a substitution
// =============================================================================

describe("canonicalization vs substitution (A4)", () => {
	it("F4: 'opus' resolving to 'claude-opus-5' is canonicalization, not a warning", async () => {
		// The adapter resolving an alias the user meant. Warning about it is
		// crying wolf, and a chip that fires on every correct write teaches the
		// user to ignore the one that matters.
		const host = new FakeAcpHost();
		host.readConfigResult = [
			option("model", "claude-opus-5", [
				{ id: "claude-opus-5", label: "Opus" },
			]),
		];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "model",
			value: "opus",
			allowUnlisted: true,
		});

		expect(result.applied.verified).toBe(false);
		expect(result.applied.canonicalized).toBe(true);
	});

	it("matches case-insensitively", async () => {
		const host = new FakeAcpHost();
		host.readConfigResult = [
			option("model", "claude-opus-5", [
				{ id: "claude-opus-5", label: "Opus" },
			]),
		];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "model",
			value: "OPUS",
			allowUnlisted: true,
		});

		expect(result.applied.canonicalized).toBe(true);
	});

	it("matches on the LABEL as well as the id", async () => {
		const host = new FakeAcpHost();
		host.readConfigResult = [
			option("model", "claude-fable-5[1m]", [
				{ id: "claude-fable-5[1m]", label: "Fable" },
			]),
		];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "model",
			value: "fable",
			allowUnlisted: true,
		});

		expect(result.applied.canonicalized).toBe(true);
	});

	it("PROVES THE CHECK FIRES: a real substitution still warns", async () => {
		// The control. Suppression that swallowed everything would pass every
		// test above, and would re-hide exactly the Agent-Canvas failure the
		// chip exists to show.
		const host = new FakeAcpHost();
		host.readConfigResult = [
			option("model", "claude-opus-5", [
				{ id: "claude-opus-5", label: "Opus" },
			]),
		];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "model",
			value: "claude-haiku-99",
			allowUnlisted: true,
		});

		expect(result.applied.verified).toBe(false);
		expect(result.applied.canonicalized).toBe(false);
	});

	it("an option that vanished is a substitution, never canonicalization", async () => {
		// `actualValue` is null: there is no id or label to be a substring of,
		// and a suppression that treated "nothing" as a match would silence it.
		const host = new FakeAcpHost();
		host.readConfigResult = [option("model", "haiku")];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "effort",
			value: "high",
		});

		expect(result.applied.actualValue).toBeNull();
		expect(result.applied.canonicalized).toBe(false);
	});

	it("a verified write is never marked canonicalized", async () => {
		const host = new FakeAcpHost();
		host.readConfigResult = [
			option("model", "claude-opus-5", [
				{ id: "claude-opus-5", label: "Opus" },
			]),
		];
		const { caller } = makeCaller(host);
		await caller.ensureSession({ paneId: "pane-1", cwd: "/repo" });

		const result = await caller.setConfigOption({
			paneId: "pane-1",
			configId: "model",
			value: "claude-opus-5",
		});

		expect(result.applied.verified).toBe(true);
		expect(result.applied.canonicalized).toBe(false);
	});
});
