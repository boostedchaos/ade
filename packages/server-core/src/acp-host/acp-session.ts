import { type ChildProcess, spawn } from "node:child_process";
import type {
	AvailableCommand,
	SessionConfigOption,
	SessionModeState,
} from "@agentclientprotocol/sdk";
import { treeKillWithEscalation } from "../tree-kill";
import { AcpConnection, type AcpSessionParams } from "./acp-connection";
import {
	getAcpBinaryPath,
	getAcpExecPath,
	spawnAcpChildEnv,
} from "./binary-resolver";
import { ConfigOptionCache, MODEL_CONFIG_ID } from "./config-options";
import { acpError } from "./errors";
import {
	autoApprovePermissionHandler,
	resolveModeIdForPolicy,
} from "./permission";
import type {
	AcpConfigSnapshot,
	AcpExitInfo,
	AcpPromptResult,
	AcpSessionInfo,
	AcpSessionOptions,
	AcpSessionState,
	AcpSessionUpdate,
	PermissionHandler,
	PermissionPolicy,
	SpawnProcess,
} from "./types";

const DEBUG_ACP = process.env.SUPERSET_ACP_DEBUG === "1";

/** `initialize` + `session/new` + the startup `session/set_mode` budget. */
const ACP_STARTUP_TIMEOUT_MS = 15_000;
/**
 * Default per-call budget for the config RPCs (`session/set_config_option`,
 * `session/resume`).
 *
 * Only the startup handshake had a timeout, so an adapter that accepted a
 * config frame and never answered left the caller's promise pending forever —
 * and a renderer that disables a control until its write settles then stays
 * disabled with no spinner and no error (A3). A coded rejection is what lets
 * the failure path clear that state.
 */
const CONFIG_RPC_TIMEOUT_MS = 30_000;
/** Fail-safe: force-dispose a session whose child never exits. */
const KILL_TIMEOUT_MS = 5000;
/** Best-effort budget for each graceful teardown RPC. */
const GRACEFUL_RPC_TIMEOUT_MS = 1000;
/** How much child stderr to keep for a spawn-failure message. */
const STDERR_TAIL_LINES = 20;

/**
 * Copy a command list a level deeper than the array, the way
 * `ConfigOptionCache.list()` copies its values.
 *
 * A spread of the array alone hands out the cached ELEMENTS: one caller tidying
 * its own copy would rewrite the cache every other pane reads. `input` is
 * copied too, and only when it exists — manufacturing `input: undefined` would
 * change the shape the wire-equality tests assert.
 */
function copyCommands(
	commands: readonly AvailableCommand[],
): AvailableCommand[] {
	return commands.map((command) =>
		command.input
			? { ...command, input: { ...command.input } }
			: { ...command },
	);
}

export interface AcpSessionHandlers {
	onUpdate: (update: AcpSessionUpdate) => void;
	onError: (err: Error) => void;
	onExit: (info: AcpExitInfo) => void;
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout: () => Error,
): Promise<T> {
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const timeoutId = setTimeout(() => rejectPromise(onTimeout()), timeoutMs);
		promise
			.then((value) => {
				clearTimeout(timeoutId);
				resolvePromise(value);
			})
			.catch((error: unknown) => {
				clearTimeout(timeoutId);
				rejectPromise(error);
			});
	});
}

/** Best-effort: swallow both failure and overrun, never block teardown. */
async function bestEffort(
	label: string,
	logPrefix: string,
	action: () => Promise<unknown>,
): Promise<void> {
	try {
		await withTimeout(
			Promise.resolve(action()),
			GRACEFUL_RPC_TIMEOUT_MS,
			() => new Error(`${label} timed out`),
		);
	} catch (error) {
		if (DEBUG_ACP) {
			console.log(`${logPrefix} ${label} during teardown failed:`, error);
		}
	}
}

/**
 * One pane's `claude-agent-acp` child: spawn, handshake, prompt, teardown.
 *
 * Owns exactly one child process and one `AcpConnection`, and is the only place
 * that translates between the pane id the callers speak and the `sessionId` the
 * ACP server mints.
 */
export class AcpSession {
	readonly paneId: string;
	readonly cwd: string;

	private readonly logPrefix: string;
	private readonly spawnProcess: SpawnProcess;
	private readonly env: Record<string, string> | undefined;
	private readonly permissionPolicy: PermissionPolicy;
	private readonly configRpcTimeoutMs: number;
	private readonly permissionHandler: PermissionHandler =
		autoApprovePermissionHandler;
	private readonly handlers: AcpSessionHandlers;
	private readonly configCache = new ConfigOptionCache();
	/**
	 * Cache generation, bumped on every re-seed. Rides on every option list
	 * that leaves this session so a renderer can refuse a list older than the
	 * one it holds — the two channels that carry them are not ordered against
	 * each other (A1).
	 */
	private configSeq = 0;
	/**
	 * Latest `available_commands_update` list, for a pane that mounts AFTER the
	 * notification fired. `session/new` never returns commands, so a renderer
	 * relying on the event stream alone would show an empty palette forever
	 * (Phase 5 D1) — and an empty palette and a dead subscription look alike.
	 */
	private availableCommands: AvailableCommand[] = [];

	private child: ChildProcess | null = null;
	private connection: AcpConnection | null = null;
	private acpSessionId: string | null = null;
	/** Exactly what went out with `session/new`; `resume()` resends it. */
	private sessionParams: AcpSessionParams | null = null;
	private modes: SessionModeState | null = null;
	private state: AcpSessionState = "starting";
	private stderrTail: string[] = [];
	private stderrPartial = "";

	private disposed = false;
	private terminatingAt: number | null = null;
	/** The `spawn` error, kept so teardown reports the cause and not a timeout. */
	private spawnFailure: Error | null = null;
	/** True when `treeKillWithEscalation` could not confirm the tree died. */
	private killFailed = false;
	private killTimer: NodeJS.Timeout | null = null;
	private exitEmitted = false;
	private childExited = false;
	private childExit: { code: number | null; signal: string | null } | null =
		null;
	private exitWaiters: (() => void)[] = [];
	private disposePromise: Promise<void> | null = null;
	/** Rejecters for every in-flight RPC, so a dead child fails them all. */
	private deathRejecters = new Set<(err: Error) => void>();

	constructor(options: AcpSessionOptions, handlers: AcpSessionHandlers) {
		this.paneId = options.paneId;
		this.cwd = options.cwd;
		this.logPrefix = `[AcpSession ${options.paneId}]`;
		this.spawnProcess = options.spawnProcess ?? spawn;
		this.env = options.env;
		this.permissionPolicy = options.permissionPolicy ?? "auto-approve";
		this.configRpcTimeoutMs =
			options.configRpcTimeoutMs ?? CONFIG_RPC_TIMEOUT_MS;
		this.handlers = handlers;
	}

	// =========================================================================
	// Startup
	// =========================================================================

	async start(): Promise<AcpSessionInfo> {
		// Throws before any spawn if the host app never registered a resolver.
		const binaryPath = getAcpBinaryPath();

		const child = this.spawnBinary(binaryPath);
		this.child = child;

		const stdin = child.stdin;
		const stdout = child.stdout;
		if (!stdin || !stdout) {
			await this.dispose();
			throw acpError(
				"acp-spawn-failed",
				`claude-agent-acp for pane ${this.paneId} was spawned without piped stdio`,
			);
		}

		this.connection = AcpConnection.open({
			logPrefix: this.logPrefix,
			cwd: this.cwd,
			stdin,
			stdout,
			callbacks: {
				onSessionUpdate: (update) => this.handleSessionUpdate(update),
				onConfigOptions: (options) => this.handleConfigOptions(options),
				onPermissionRequest: (req) => this.permissionHandler(req),
				onClosed: (error) => {
					if (DEBUG_ACP && error) {
						console.log(`${this.logPrefix} ACP connection closed:`, error);
					}
				},
			},
		});

		try {
			await withTimeout(
				this.racingDeath(this.handshake()),
				ACP_STARTUP_TIMEOUT_MS,
				() =>
					acpError(
						"acp-startup-timeout",
						`claude-agent-acp for pane ${this.paneId} did not complete initialize/session-new within ${ACP_STARTUP_TIMEOUT_MS}ms`,
					),
			);
		} catch (error) {
			await this.dispose();
			throw this.startupError(error);
		}

		this.state = "ready";
		return this.info();
	}

	private spawnBinary(binaryPath: string): ChildProcess {
		// The adapter is a Node entry script run under a Node-compatible runtime.
		// WHICH runtime is a host-app decision, not an assumption made here: the
		// desktop app wants Electron-as-node, `apps/server` runs under bun and
		// must override to plain node. `spawnAcpChildEnv` adds
		// ELECTRON_RUN_AS_NODE for the `process.execPath` case and gives the
		// child a real PATH/HOME. The resolver owns where the script lives, so
		// nothing here assumes a dist layout either.
		const execPath = getAcpExecPath();
		const child = this.spawnProcess(execPath, [binaryPath], {
			cwd: this.cwd,
			env: spawnAcpChildEnv(execPath, this.env),
			stdio: ["pipe", "pipe", "pipe"],
		});

		child.stderr?.on("data", (chunk: Buffer | string) => {
			this.consumeStderr(chunk.toString());
		});

		child.on("error", (error) => {
			// A failed spawn emits `error` + `close` and NEVER `exit`, and leaves
			// `pid` undefined (verified against Node on this platform). So the
			// teardown ladder has nothing to kill and nothing to wait for: record
			// the real cause, mark the child gone, and release the waiters — else
			// teardown blocks until KILL_TIMEOUT_MS and reports the wrong reason.
			this.spawnFailure = acpError(
				"acp-spawn-failed",
				`claude-agent-acp for pane ${this.paneId} failed to spawn ` +
					`(${execPath} ${binaryPath}): ${error.message}`,
			);
			this.childExited = true;
			this.childExit ??= { code: null, signal: null };
			this.releaseExitWaiters();
			this.failInFlight(this.spawnFailure);
		});

		child.on("exit", (code, signal) => {
			this.handleChildExit(code, signal);
		});

		// Backstop: `close` always fires, `exit` does not (see above). Only acts
		// when nothing has already accounted for the child being gone.
		child.on("close", (code, signal) => {
			if (this.childExited) return;
			this.handleChildExit(code, signal);
		});

		return child;
	}

	private async handshake(): Promise<void> {
		const connection = this.requireConnection();

		await connection.initialize();
		// Built once and kept: `resume()` has to resend these values unchanged
		// or the adapter replaces the live session (see `AcpSessionParams`).
		this.sessionParams = { cwd: this.cwd, mcpServers: [] };
		const session = await connection.newSession(this.sessionParams);

		this.acpSessionId = session.sessionId;
		this.modes = session.modes ?? null;
		this.reseedConfig(session.configOptions);

		// Set the mode explicitly rather than trusting the adapter's default to
		// stay put: in bypass mode it never consults `canUseTool`, so the policy
		// lives in the mode, not in the callback (Phase 0 findings).
		const modeId = resolveModeIdForPolicy(this.permissionPolicy, this.modes);
		if (modeId && modeId !== this.modes?.currentModeId) {
			await connection.setMode(session.sessionId, modeId);
			if (this.modes) {
				this.modes = { ...this.modes, currentModeId: modeId };
			}
		}
	}

	/** Startup failures are reported as spawn failures unless already coded. */
	private startupError(error: unknown): Error {
		// The `error` event carries `spawn ENOENT` and the path; whatever the
		// torn-down SDK connection rejected with carries neither.
		if (this.spawnFailure) return this.spawnFailure;
		if (
			error instanceof Error &&
			(error.message.startsWith("acp-startup-timeout") ||
				error.message.startsWith("acp-spawn-failed") ||
				// A dispose that landed mid-handshake is a disposal, not a spawn
				// failure; wrapping it hides the code the caller branches on.
				error.message.startsWith("acp-session-disposed"))
		) {
			return error;
		}
		const reason = error instanceof Error ? error.message : String(error);
		const stderr = this.stderrTail.join("\n");
		return acpError(
			"acp-spawn-failed",
			`claude-agent-acp for pane ${this.paneId} failed during startup: ${reason}` +
				(stderr ? `\nchild stderr:\n${stderr}` : ""),
		);
	}

	// =========================================================================
	// Public methods
	// =========================================================================

	get sessionState(): AcpSessionState {
		return this.state;
	}

	info(): AcpSessionInfo {
		return {
			paneId: this.paneId,
			acpSessionId: this.acpSessionId ?? "",
			state: this.state,
			modes: this.modes,
			configOptions: this.configCache.list(),
			configSeq: this.configSeq,
			availableCommands: copyCommands(this.availableCommands),
		};
	}

	async prompt(text: string): Promise<AcpPromptResult> {
		const { connection, sessionId } = this.requireLive();

		// One turn per session. Two overlapping prompts put two frames on the
		// wire against one `sessionId`, and `cancel()` cancels BY SESSION — so it
		// would kill both, while the first `finally` to run would reset the state
		// to `ready` with the other still going. Reject the second instead.
		if (this.state === "prompting") {
			throw acpError(
				"acp-prompt-in-flight",
				`ACP session for pane ${this.paneId} already has a prompt in flight`,
			);
		}

		this.state = "prompting";
		try {
			const response = await this.racingDeath(
				connection.prompt(sessionId, text),
			);
			return { stopReason: response.stopReason };
		} finally {
			if (this.state === "prompting") {
				this.state = "ready";
			}
		}
	}

	/** No-op when the session is idle or already gone; never throws for that. */
	async cancel(): Promise<void> {
		if (this.disposed || this.state !== "prompting") return;
		const connection = this.connection;
		const sessionId = this.acpSessionId;
		if (!connection || !sessionId) return;

		await this.racingDeath(connection.cancel(sessionId));
	}

	/**
	 * `allowUnlisted` waives the local gate, and ONLY for the model option.
	 *
	 * The adapter's model list is not exhaustive, so a model the caller can name
	 * but the list omits has to stay reachable. It is tolerable only there
	 * because a model id the adapter cannot place fuzzy-resolves to another
	 * VALID model rather than breaking the session — and the caller's mandatory
	 * `resume()` read-back is what turns that silent substitution into
	 * something the user can see. Every other option id keeps the gate, where an
	 * undeclared value has no such floor.
	 */
	async setConfigOption(
		optionId: string,
		value: string,
		options: { allowUnlisted?: boolean } = {},
	): Promise<void> {
		const { connection, sessionId } = this.requireLive();

		// The gate, not the server's answer: an illegal value is ACCEPTED and
		// silently downgraded to `default`, so a green write proves nothing.
		const unlisted =
			options.allowUnlisted === true && optionId === MODEL_CONFIG_ID;
		if (!unlisted) {
			this.configCache.assertValid(optionId, value);
		}

		const wireValue = this.configCache.isBoolean(optionId)
			? value === "true"
			: value;
		const response = await this.racingDeath(
			withTimeout(
				connection.setConfigOption(sessionId, optionId, wireValue),
				this.configRpcTimeoutMs,
				() =>
					acpError(
						"acp-rpc-timeout",
						`session/set_config_option for pane ${this.paneId} did not answer within ${this.configRpcTimeoutMs}ms`,
					),
			),
		);

		// No optimistic local write. This adapter answers success for a value it
		// silently resolved to something else, so writing the REQUESTED value
		// into the cache would make an unverified write indistinguishable from a
		// verified one — and every caller here is required to follow with a
		// `resume()` read-back anyway, which is the only thing that can tell
		// them apart (A2).
		if (response.configOptions.length > 0) {
			this.reseedConfig(response.configOptions);
		}
	}

	/**
	 * Read config state back off the wire and re-seed the cache.
	 *
	 * The only verified on-demand read-back this adapter offers, and the only
	 * thing that can tell a write that landed from a write that was silently
	 * resolved to something else. Non-destructive strictly because it resends
	 * the recorded `session/new` params (`AcpSessionParams`).
	 */
	async resume(): Promise<AcpConfigSnapshot> {
		const { connection, sessionId } = this.requireLive();
		const params = this.sessionParams;
		if (!params) {
			throw acpError(
				"acp-session-disposed",
				`ACP session for pane ${this.paneId} has no recorded session/new params`,
			);
		}

		const response = await this.racingDeath(
			withTimeout(
				connection.resumeSession(sessionId, params),
				this.configRpcTimeoutMs,
				() =>
					acpError(
						"acp-rpc-timeout",
						`session/resume for pane ${this.paneId} did not answer within ${this.configRpcTimeoutMs}ms`,
					),
			),
		);

		if (response.modes) {
			this.modes = response.modes;
		}
		// Guarded, not `?? []`: an ABSENT `configOptions` means the adapter
		// reported nothing this time, which is not the same claim as "this
		// session has no options" and must not empty the bar. It also means the
		// list below is the cache's own memory rather than anything the wire
		// just confirmed, which `fromWire` is what tells the caller (A2).
		const fromWire = response.configOptions !== undefined;
		if (response.configOptions) {
			this.reseedConfig(response.configOptions);
		}
		return { options: this.configCache.list(), seq: this.configSeq, fromWire };
	}

	async setMode(modeId: string): Promise<void> {
		const { connection, sessionId } = this.requireLive();

		// Same gate as `setConfigOption`, and it matters more: the permission
		// policy IS the mode. Phase 0 proved this adapter accepts illegal config
		// values silently, and nothing establishes `session/set_mode` differs —
		// so an unvalidated write could leave the cache claiming a restrictive
		// mode while the child stays in whatever it was.
		this.assertModeAvailable(modeId);

		await this.racingDeath(connection.setMode(sessionId, modeId));
		if (this.modes) {
			this.modes = { ...this.modes, currentModeId: modeId };
		}
	}

	/**
	 * `session/new` returns `modes.availableModes`; validate against it.
	 *
	 * No declared list means the adapter offered none, so there is nothing to
	 * validate against and the write goes out unchecked rather than being
	 * refused on a guess.
	 */
	private assertModeAvailable(modeId: string): void {
		const available = this.modes?.availableModes;
		if (!available || available.length === 0) return;
		if (available.some((mode) => mode.id === modeId)) return;
		throw acpError(
			"acp-invalid-mode",
			`mode "${modeId}" is not available for pane ${this.paneId} ` +
				`(declared: ${available.map((mode) => mode.id).join(", ")})`,
		);
	}

	// =========================================================================
	// Teardown
	// =========================================================================

	/** Idempotent full teardown ladder. */
	dispose(): Promise<void> {
		this.disposePromise ??= this.runTeardown();
		return this.disposePromise;
	}

	private async runTeardown(): Promise<void> {
		// `terminatingAt` is set before any signal goes out, so the child's exit
		// handler can tell an expected exit from a death.
		this.terminatingAt = Date.now();
		this.disposed = true;
		this.state = "terminating";

		this.armKillTimer();

		const connection = this.connection;
		const sessionId = this.acpSessionId;

		if (connection && sessionId) {
			if (this.hasInFlightWork()) {
				await bestEffort("session/cancel", this.logPrefix, () =>
					connection.cancel(sessionId),
				);
			}
			await bestEffort("session/close", this.logPrefix, () =>
				connection.closeSession(sessionId),
			);
		}

		// Design §5 promises `acp-session-disposed` for a method interrupted by
		// dispose. The death path does this via `racingDeath`; without it here,
		// an in-flight RPC rejects with the SDK's uncoded "ACP connection closed"
		// as soon as the connection goes, which no caller can branch on.
		this.failInFlight(
			acpError(
				"acp-session-disposed",
				`ACP session for pane ${this.paneId} has been disposed`,
			),
		);

		connection?.close();
		this.child?.stdin?.destroy();

		const pid = this.child?.pid;
		if (pid !== undefined && !this.childExited) {
			const result = await treeKillWithEscalation({
				pid,
				signal: "SIGTERM",
				escalationTimeoutMs: 2000,
			});
			if (!result.success) {
				// Not just a log line: a tree we could not kill means this teardown
				// did NOT succeed, and `expected: true` would report it as clean.
				this.killFailed = true;
				console.warn(
					`${this.logPrefix} failed to kill process tree ${pid}: ${result.error ?? "unknown error"}`,
				);
			}
		}

		await this.waitForExit();
		this.finalize({
			code: this.childExit?.code ?? null,
			signal: this.childExit?.signal ?? null,
			expected: this.teardownSucceeded(),
		});
	}

	/**
	 * Did the ladder actually end the child?
	 *
	 * `expected` means "this exit followed our teardown AND the teardown
	 * worked". A stuck child, or a `treeKillWithEscalation` that could not
	 * confirm the kill, is not a clean exit however deliberately it was
	 * attempted — reporting it as one is how a leaked process stays invisible.
	 */
	private teardownSucceeded(): boolean {
		if (this.killFailed) return false;
		return this.child === null || this.childExited;
	}

	private armKillTimer(): void {
		if (this.killTimer) return;
		const timer = setTimeout(() => {
			this.killTimer = null;
			if (this.state !== "terminating") return;
			console.warn(
				`${this.logPrefix} force disposing stuck session after ${KILL_TIMEOUT_MS}ms`,
			);
			this.finalize({
				code: this.childExit?.code ?? null,
				signal: this.childExit?.signal ?? null,
				expected: this.teardownSucceeded(),
			});
		}, KILL_TIMEOUT_MS);
		timer.unref();
		this.killTimer = timer;
	}

	private waitForExit(): Promise<void> {
		if (this.child === null || this.childExited || this.exitEmitted) {
			return Promise.resolve();
		}
		return new Promise<void>((resolveWaiter) => {
			this.exitWaiters.push(resolveWaiter);
		});
	}

	private releaseExitWaiters(): void {
		for (const waiter of this.exitWaiters.splice(0)) {
			waiter();
		}
	}

	private handleChildExit(code: number | null, signal: string | null): void {
		const expected = this.terminatingAt !== null;
		this.childExited = true;
		this.childExit = { code, signal };

		this.releaseExitWaiters();

		if (expected) {
			// runTeardown() finalizes; nothing to do beyond releasing the waiters.
			return;
		}

		const error = acpError(
			"acp-session-died",
			`claude-agent-acp for pane ${this.paneId} exited (code ${code}, signal ${signal}) mid-turn`,
		);
		this.failInFlight(error);
		this.connection?.close();
		this.handlers.onError(error);
		this.finalize({ code, signal, expected: false });
	}

	/** Emit `exit` exactly once and settle into a terminal state. */
	private finalize(info: AcpExitInfo): void {
		if (this.exitEmitted) return;
		this.exitEmitted = true;

		if (this.killTimer) {
			clearTimeout(this.killTimer);
			this.killTimer = null;
		}
		this.disposed = true;
		this.state = "dead";

		this.releaseExitWaiters();

		this.handlers.onExit(info);
	}

	// =========================================================================
	// Internals
	// =========================================================================

	/**
	 * A `config_option_update` is the only unsolicited truth signal we get about
	 * config state, so it overwrites the cache wholesale.
	 */
	private handleConfigOptions(options: SessionConfigOption[]): void {
		this.reseedConfig(options);
	}

	/** The ONE place the cache is replaced, so the generation cannot be missed. */
	private reseedConfig(
		options: readonly SessionConfigOption[] | null | undefined,
	): void {
		this.configCache.replaceAll(options);
		this.configSeq++;
	}

	private handleSessionUpdate(update: AcpSessionUpdate): void {
		if (update.kind === "available_commands_update") {
			// Replaced BEFORE the re-emit: a renderer that reacts to the event by
			// reading `info()` must not see the previous list.
			this.availableCommands = copyCommands(update.commands);
		}
		if (update.kind === "current_mode_update" && this.modes) {
			this.modes = { ...this.modes, currentModeId: update.modeId };
		}
		if (update.kind === "config_option_update") {
			// `AcpConnection` fires `onConfigOptions` before this, so the cache
			// has already been re-seeded and `configSeq` is this list's own
			// generation. The mapper cannot know it (`UNSTAMPED_CONFIG_SEQ`).
			this.handlers.onUpdate({ ...update, seq: this.configSeq });
			return;
		}
		this.handlers.onUpdate(update);
	}

	private consumeStderr(chunk: string): void {
		this.stderrPartial += chunk;
		const lines = this.stderrPartial.split("\n");
		this.stderrPartial = lines.pop() ?? "";
		for (const line of lines) {
			if (line.length === 0) continue;
			console.warn(`${this.logPrefix} stderr: ${line}`);
			this.stderrTail.push(line);
			if (this.stderrTail.length > STDERR_TAIL_LINES) {
				this.stderrTail.shift();
			}
		}
	}

	private hasInFlightWork(): boolean {
		return this.deathRejecters.size > 0;
	}

	/** Fail every in-flight RPC with the same coded error. */
	private failInFlight(error: Error): void {
		for (const reject of Array.from(this.deathRejecters)) {
			reject(error);
		}
		this.deathRejecters.clear();
	}

	/**
	 * Race an RPC against the child dying, so a death produces the stable
	 * `acp-session-died` message rather than whatever the torn-down SDK
	 * connection happens to reject with.
	 */
	private racingDeath<T>(promise: Promise<T>): Promise<T> {
		return new Promise<T>((resolvePromise, rejectPromise) => {
			const reject = (error: Error) => {
				this.deathRejecters.delete(reject);
				rejectPromise(error);
			};
			this.deathRejecters.add(reject);

			promise.then(
				(value) => {
					this.deathRejecters.delete(reject);
					resolvePromise(value);
				},
				(error: unknown) => {
					this.deathRejecters.delete(reject);
					rejectPromise(error);
				},
			);
		});
	}

	private requireConnection(): AcpConnection {
		const connection = this.connection;
		if (!connection) {
			throw acpError(
				"acp-spawn-failed",
				`claude-agent-acp for pane ${this.paneId} has no live connection`,
			);
		}
		return connection;
	}

	/** The disposed guard every public method runs first. */
	private requireLive(): { connection: AcpConnection; sessionId: string } {
		if (this.disposed || this.terminatingAt !== null) {
			throw acpError(
				"acp-session-disposed",
				`ACP session for pane ${this.paneId} has been disposed`,
			);
		}
		const connection = this.connection;
		const sessionId = this.acpSessionId;
		if (!connection || !sessionId) {
			throw acpError(
				"acp-session-disposed",
				`ACP session for pane ${this.paneId} is not ready`,
			);
		}
		return { connection, sessionId };
	}
}
