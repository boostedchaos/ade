import { type ChildProcess, spawn } from "node:child_process";
import type {
	SessionConfigOption,
	SessionModeState,
} from "@agentclientprotocol/sdk";
import { treeKillWithEscalation } from "../tree-kill";
import { AcpConnection } from "./acp-connection";
import { getAcpBinaryPath } from "./binary-resolver";
import { ConfigOptionCache } from "./config-options";
import { acpError } from "./errors";
import {
	autoApprovePermissionHandler,
	resolveModeIdForPolicy,
} from "./permission";
import type {
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
/** Fail-safe: force-dispose a session whose child never exits. */
const KILL_TIMEOUT_MS = 5000;
/** Best-effort budget for each graceful teardown RPC. */
const GRACEFUL_RPC_TIMEOUT_MS = 1000;
/** How much child stderr to keep for a spawn-failure message. */
const STDERR_TAIL_LINES = 20;

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
	private readonly permissionHandler: PermissionHandler =
		autoApprovePermissionHandler;
	private readonly handlers: AcpSessionHandlers;
	private readonly configCache = new ConfigOptionCache();

	private child: ChildProcess | null = null;
	private connection: AcpConnection | null = null;
	private acpSessionId: string | null = null;
	private modes: SessionModeState | null = null;
	private state: AcpSessionState = "starting";
	private stderrTail: string[] = [];
	private stderrPartial = "";

	private disposed = false;
	private terminatingAt: number | null = null;
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
		// The adapter is a Node entry script run under the current runtime; the
		// resolver owns where it lives, so nothing here assumes a dist layout.
		const child = this.spawnProcess(process.execPath, [binaryPath], {
			cwd: this.cwd,
			env: this.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		child.stderr?.on("data", (chunk: Buffer | string) => {
			this.consumeStderr(chunk.toString());
		});

		child.on("error", (error) => {
			this.failInFlight(
				acpError(
					"acp-spawn-failed",
					`claude-agent-acp for pane ${this.paneId} failed to spawn: ${error.message}`,
				),
			);
		});

		child.on("exit", (code, signal) => {
			this.handleChildExit(code, signal);
		});

		return child;
	}

	private async handshake(): Promise<void> {
		const connection = this.requireConnection();

		await connection.initialize();
		const session = await connection.newSession(this.cwd);

		this.acpSessionId = session.sessionId;
		this.modes = session.modes ?? null;
		this.configCache.replaceAll(session.configOptions);

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
		if (
			error instanceof Error &&
			(error.message.startsWith("acp-startup-timeout") ||
				error.message.startsWith("acp-spawn-failed"))
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
		};
	}

	async prompt(text: string): Promise<AcpPromptResult> {
		const { connection, sessionId } = this.requireLive();

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

	async setConfigOption(optionId: string, value: string): Promise<void> {
		const { connection, sessionId } = this.requireLive();

		// The gate, not the server's answer: an illegal value is ACCEPTED and
		// silently downgraded to `default`, so a green write proves nothing.
		this.configCache.assertValid(optionId, value);

		const wireValue = this.configCache.isBoolean(optionId)
			? value === "true"
			: value;
		const response = await this.racingDeath(
			connection.setConfigOption(sessionId, optionId, wireValue),
		);

		if (response.configOptions.length > 0) {
			this.configCache.replaceAll(response.configOptions);
		} else {
			this.configCache.applyLocalWrite(optionId, value);
		}
	}

	async setMode(modeId: string): Promise<void> {
		const { connection, sessionId } = this.requireLive();
		await this.racingDeath(connection.setMode(sessionId, modeId));
		if (this.modes) {
			this.modes = { ...this.modes, currentModeId: modeId };
		}
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
				console.warn(
					`${this.logPrefix} failed to kill process tree ${pid}: ${result.error ?? "unknown error"}`,
				);
			}
		}

		await this.waitForExit();
		this.finalize({
			code: this.childExit?.code ?? null,
			signal: this.childExit?.signal ?? null,
			expected: true,
		});
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
				expected: true,
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

	private handleChildExit(code: number | null, signal: string | null): void {
		const expected = this.terminatingAt !== null;
		this.childExited = true;
		this.childExit = { code, signal };

		for (const waiter of this.exitWaiters.splice(0)) {
			waiter();
		}

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

		for (const waiter of this.exitWaiters.splice(0)) {
			waiter();
		}

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
		this.configCache.replaceAll(options);
	}

	private handleSessionUpdate(update: AcpSessionUpdate): void {
		if (update.kind === "current_mode_update" && this.modes) {
			this.modes = { ...this.modes, currentModeId: update.modeId };
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
