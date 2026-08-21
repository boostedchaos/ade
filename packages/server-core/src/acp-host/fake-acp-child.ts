/**
 * TEST-ONLY: a scripted fake `claude-agent-acp` child process.
 *
 * Not exported from `index.ts` and not used by any runtime path — it exists so
 * the unit suite can drive `AcpSession` / `AcpHost` through the REAL
 * `@agentclientprotocol/sdk`. Its `stdout` is a genuine Node `Readable` and its
 * `stdin` a genuine `Writable`, so `ndJsonStream()` does its own framing and
 * the SDK does its own request/response correlation. Nothing about the wire is
 * mocked: the only fake part is who is on the other end of it.
 *
 * The default fixtures mirror the Phase 0 spike
 * (`planning/spikes/acp-phase0/FINDINGS.md`): a `model` select carrying Fable,
 * an `effort` select, and the six permission modes.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type {
	SessionConfigOption,
	SessionModeState,
	SessionUpdate,
} from "@agentclientprotocol/sdk";

export interface JsonRpcFrame {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** Returned by a handler that should NOT answer yet (the test answers later). */
export const NO_REPLY = Symbol("fake-acp-child-no-reply");

/**
 * Thrown by a handler that must answer with a SPECIFIC JSON-RPC code.
 *
 * An ordinary `Error` becomes `-32603` (internal error), which is fine for
 * "this blew up" but useless for the cases that are ABOUT the code — the host
 * falls back to a fresh session on `-32002` / `-32602` and fails the startup on
 * anything else, and a test that cannot choose the code cannot tell the two
 * apart.
 */
export class FakeRequestError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

export type FakeHandler = (
	params: Record<string, unknown>,
	id: number | string | undefined,
) => unknown;

export const FIXTURE_SESSION_ID = "acp-session-fixture-1";

/** The six permission modes the adapter reported in the Phase 0 spike. */
export const FIXTURE_MODES: SessionModeState = {
	currentModeId: "default",
	availableModes: [
		{ id: "default", name: "Default" },
		{ id: "acceptEdits", name: "Accept Edits" },
		{ id: "bypassPermissions", name: "Bypass Permissions" },
		{ id: "plan", name: "Plan" },
		{ id: "dontAsk", name: "Don't Ask" },
		{ id: "auto", name: "Auto" },
	],
};

/** `model` and `effort`, with the values the spike recorded. */
export function fixtureConfigOptions(): SessionConfigOption[] {
	return [
		{
			id: "model",
			name: "Model",
			type: "select",
			currentValue: "default",
			options: [
				{ value: "default", name: "Default" },
				{ value: "opus[1m]", name: "Opus" },
				{ value: "claude-fable-5[1m]", name: "Fable" },
				{ value: "sonnet", name: "Sonnet" },
				{ value: "haiku", name: "Haiku" },
			],
		},
		{
			id: "effort",
			name: "Effort",
			type: "select",
			currentValue: "medium",
			options: [
				{ value: "default", name: "Default" },
				{ value: "low", name: "Low" },
				{ value: "medium", name: "Medium" },
				{ value: "high", name: "High" },
				{ value: "xhigh", name: "Extra High" },
				{ value: "max", name: "Max" },
			],
		},
		{
			id: "fast",
			name: "Fast mode",
			type: "boolean",
			currentValue: false,
		},
	];
}

/**
 * One tool call's whole lifecycle, as the live capture recorded it
 * (`planning/spikes/acp-phase3-capture/frames.json`, the `Edit beta.txt` card):
 * a `tool_call` announcing a generic title and `pending`, a refinement that
 * fills in the real title and `locations`, a diff-content update, a SECOND
 * diff update replacing the first (the PostToolUse hook — this is the frame
 * that makes append-instead-of-replace show the edit twice), and a final
 * update carrying nothing but `status: completed`.
 *
 * `in_progress` is deliberately absent: it never appeared on the wire for a
 * short tool (design ground truth 2), so a fixture that emitted it would be
 * testing a state the renderer has never been sent.
 *
 * Returned as plain frames for the caller to feed through
 * `FakeAcpChild.sessionUpdate`, so the test drives the real JSON-RPC seam
 * rather than calling the mapper directly.
 */
export type FixtureToolCallFrame = Extract<
	SessionUpdate,
	{ sessionUpdate: "tool_call" | "tool_call_update" }
>;

export function fixtureToolCallSequence(
	toolCallId = "toolu_fixture_edit",
	path = "/repo/beta.txt",
): FixtureToolCallFrame[] {
	const diff = (oldText: string, newText: string) => ({
		type: "diff" as const,
		path,
		oldText,
		newText,
	});
	return [
		{
			sessionUpdate: "tool_call",
			toolCallId,
			title: "Edit",
			kind: "edit",
			status: "pending",
			content: [],
			locations: [],
			rawInput: { file_path: path },
			_meta: { claudeCode: { toolName: "Edit" } },
		},
		{
			sessionUpdate: "tool_call_update",
			toolCallId,
			kind: "edit",
			title: "Edit beta.txt",
			locations: [{ path }],
			rawInput: { file_path: path },
			_meta: { claudeCode: { toolName: "Edit" } },
		},
		{
			sessionUpdate: "tool_call_update",
			toolCallId,
			content: [diff("beta line 2", "beta line 2 EDITED")],
			locations: [{ path }],
			_meta: { claudeCode: { toolName: "Edit" } },
		},
		{
			sessionUpdate: "tool_call_update",
			toolCallId,
			content: [
				diff("beta line 1\nbeta line 2", "beta line 1\nbeta line 2 EDITED"),
			],
			locations: [{ path, line: 1 }],
			_meta: { claudeCode: { toolName: "Edit" } },
		},
		{
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: "completed",
			rawOutput: "The file has been updated.",
			_meta: { claudeCode: { toolName: "Edit" } },
		},
	];
}

/**
 * A scripted conversation for `session/load` to replay (A1).
 *
 * Ordinary `session/update` notifications with no history marker of any kind,
 * because that is exactly what the adapter replays — the client cannot tell a
 * replayed frame from a live one, which is the whole reason the router needs
 * an event buffer.
 */
export function fixtureReplayHistory(): SessionUpdate[] {
	return [
		{
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "edit beta.txt for me" },
		},
		{
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Editing it now." },
		},
		...fixtureToolCallSequence(),
		{
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Done." },
		},
	];
}

export interface FakeAcpChildOptions {
	/** Defaults to `undefined` so teardown never signals a real pid. */
	pid?: number;
	sessionId?: string;
	modes?: SessionModeState | null;
	configOptions?: SessionConfigOption[];
	/** When false, `session/prompt` is left hanging for the test to answer. */
	autoRespondPrompt?: boolean;
	/**
	 * By default the child exits once Argus destroys its stdin, the way a real
	 * adapter does at the end of the teardown ladder. Set false for a child that
	 * hangs, so the KILL_TIMEOUT_MS fail-safe is what ends the teardown.
	 */
	exitOnStdinClose?: boolean;
	/** When false, `stdout` is null — the "spawned without piped stdio" case. */
	pipeStdout?: boolean;
	promptStopReason?: string;
	/**
	 * What `session/load` replays before it answers. Defaults to
	 * `fixtureReplayHistory()`; `[]` loads a session with no history.
	 */
	loadReplay?: SessionUpdate[];
	/**
	 * Make `session/load` fail instead. `-32002` (resourceNotFound) and
	 * `-32602` (invalidParams) are the two the host falls back to a fresh
	 * session on; anything else should fail the startup.
	 */
	loadSessionError?: { code: number; message: string };
	/** When false, `initialize` reports no `loadSession` capability. */
	supportsLoadSession?: boolean;
}

class CapturingStdin extends Writable {
	constructor(private readonly onLine: (line: string) => void) {
		super();
	}

	override _write(
		chunk: Buffer | string,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		this.onLine(chunk.toString());
		callback();
	}
}

export class FakeAcpChild extends EventEmitter {
	readonly stdout: PassThrough | null;
	readonly stderr = new PassThrough();
	readonly stdin: Writable;

	/** Every JSON-RPC frame Argus has written, in order. */
	readonly received: JsonRpcFrame[] = [];

	pid: number | undefined;
	killed = false;
	private exited = false;
	readonly killSignals: (string | number)[] = [];

	readonly sessionId: string;

	private buffer = "";
	private nextId = 1;
	private readonly handlers = new Map<string, FakeHandler>();
	private readonly awaited = new Map<
		string,
		((frame: JsonRpcFrame) => void)[]
	>();
	private readonly outbound = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();

	constructor(options: FakeAcpChildOptions = {}) {
		super();
		this.pid = options.pid;
		this.stdout = options.pipeStdout === false ? null : new PassThrough();
		this.sessionId = options.sessionId ?? FIXTURE_SESSION_ID;
		this.stdin = new CapturingStdin((line) => this.consume(line));
		if (options.exitOnStdinClose !== false) {
			this.stdin.once("close", () => this.exit(0, null));
		}

		const modes =
			options.modes === undefined
				? FIXTURE_MODES
				: (options.modes ?? undefined);
		const configOptions = options.configOptions ?? fixtureConfigOptions();
		const stopReason = options.promptStopReason ?? "end_turn";

		this.setHandler("initialize", () => ({
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: options.supportsLoadSession !== false,
				promptCapabilities: {
					image: false,
					audio: false,
					embeddedContext: true,
				},
			},
			authMethods: [],
		}));
		this.setHandler("session/new", () => ({
			sessionId: this.sessionId,
			modes,
			configOptions,
		}));
		// Replays the scripted history, THEN answers — the adapter's own order,
		// and the reason a load can deliver a whole conversation to a client that
		// has not finished starting up yet. `session/load` mints no id: it
		// reopens the one it was given.
		this.setHandler("session/load", (params) => {
			if (options.loadSessionError) {
				throw new FakeRequestError(
					options.loadSessionError.code,
					options.loadSessionError.message,
				);
			}
			const sessionId = String(params.sessionId ?? this.sessionId);
			for (const update of options.loadReplay ?? fixtureReplayHistory()) {
				this.notify("session/update", { sessionId, update });
			}
			return { modes, configOptions };
		});
		// Same payload as `session/new`, which is what a non-destructive resume
		// reports. A test that wants the read-back to disagree with the write
		// overrides this handler.
		this.setHandler("session/resume", () => ({ modes, configOptions }));
		this.setHandler("session/set_mode", () => ({}));
		this.setHandler("session/set_config_option", () => ({ configOptions: [] }));
		this.setHandler("session/close", () => ({}));
		this.setHandler("session/prompt", () =>
			options.autoRespondPrompt === false ? NO_REPLY : { stopReason },
		);
	}

	/** Hand this to `AcpSessionOptions.spawnProcess`. */
	asChildProcess(): ChildProcess {
		return this as unknown as ChildProcess;
	}

	/** `SpawnProcess`-shaped factory that always returns this child. */
	get spawnProcess(): (
		command: string,
		args: string[],
		options: unknown,
	) => ChildProcess {
		return () => this.asChildProcess();
	}

	kill(signal?: string | number): boolean {
		this.killed = true;
		this.killSignals.push(signal ?? "SIGTERM");
		return true;
	}

	setHandler(method: string, handler: FakeHandler): void {
		this.handlers.set(method, handler);
	}

	/** Method names of every request/notification Argus sent, in order. */
	sentMethods(): string[] {
		return this.received.flatMap((frame) =>
			frame.method === undefined ? [] : [frame.method],
		);
	}

	framesFor(method: string): JsonRpcFrame[] {
		return this.received.filter((frame) => frame.method === method);
	}

	/** Resolves with the first frame for `method` — including one already seen. */
	waitFor(method: string): Promise<JsonRpcFrame> {
		const existing = this.framesFor(method)[0];
		if (existing) return Promise.resolve(existing);
		return new Promise<JsonRpcFrame>((resolve) => {
			const waiters = this.awaited.get(method) ?? [];
			waiters.push(resolve);
			this.awaited.set(method, waiters);
		});
	}

	respond(id: number | string, result: unknown): void {
		this.write({ jsonrpc: "2.0", id, result });
	}

	respondError(id: number | string, code: number, message: string): void {
		this.write({ jsonrpc: "2.0", id, error: { code, message } });
	}

	notify(method: string, params: Record<string, unknown>): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	/** Agent → client request; resolves with the client's result. */
	request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			this.outbound.set(id, { resolve, reject });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** Send one `session/update` notification for this child's session. */
	sessionUpdate(update: SessionUpdate | Record<string, unknown>): void {
		this.notify("session/update", { sessionId: this.sessionId, update });
	}

	writeStderr(text: string): void {
		this.stderr.write(text);
	}

	/** Simulate the process exiting. Ends stdout so the SDK sees EOF. */
	exit(code: number | null = 0, signal: string | null = null): void {
		if (this.exited) return;
		this.exited = true;
		this.stdout?.end();
		this.emit("exit", code, signal);
	}

	/** Simulate `spawn()` failing outright. */
	failSpawn(message: string): void {
		this.emit("error", new Error(message));
	}

	private write(frame: JsonRpcFrame): void {
		this.stdout?.write(`${JSON.stringify(frame)}\n`);
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (line.trim() === "") continue;
			this.handleFrame(JSON.parse(line) as JsonRpcFrame);
		}
	}

	private handleFrame(frame: JsonRpcFrame): void {
		// A response to one of OUR requests (permission, fs/*).
		if (frame.method === undefined && frame.id !== undefined) {
			const pending = this.outbound.get(Number(frame.id));
			if (pending) {
				this.outbound.delete(Number(frame.id));
				if (frame.error) {
					pending.reject(
						new Error(`${frame.error.code}: ${frame.error.message}`),
					);
				} else {
					pending.resolve(frame.result);
				}
			}
			return;
		}

		this.received.push(frame);

		if (frame.method !== undefined) {
			for (const waiter of this.awaited.get(frame.method) ?? []) {
				waiter(frame);
			}
			this.awaited.delete(frame.method);
		}

		if (frame.method === undefined || frame.id === undefined) return;

		const handler = this.handlers.get(frame.method);
		if (!handler) {
			this.respondError(frame.id, -32601, `method not found: ${frame.method}`);
			return;
		}

		const id = frame.id;
		const fail = (error: unknown) => {
			this.respondError(
				id,
				error instanceof FakeRequestError ? error.code : -32603,
				error instanceof Error ? error.message : String(error),
			);
		};

		// The handler call is INSIDE the try. Argus writes to this child's stdin
		// synchronously from inside its own `request()`, so a handler that throws
		// synchronously would otherwise unwind straight back out of that call —
		// the caller would see the raw thrown object instead of a JSON-RPC error
		// response, which is not how any real agent behaves and would make a
		// coded-error test pass for the wrong reason.
		let outcome: unknown;
		try {
			outcome = handler(frame.params ?? {}, frame.id);
		} catch (error) {
			fail(error);
			return;
		}
		if (outcome === NO_REPLY) return;
		void Promise.resolve(outcome).then(
			(result) => this.respond(id, result),
			fail,
		);
	}
}
