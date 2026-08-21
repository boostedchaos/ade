import { EventEmitter } from "node:events";
import { AcpSession } from "./acp-session";
import { acpError } from "./errors";
import type {
	AcpPromptResult,
	AcpSessionInfo,
	AcpSessionOptions,
} from "./types";

const DEBUG_ACP = process.env.SUPERSET_ACP_DEBUG === "1";

/**
 * How many ACP children may be STARTING at once (not how many may be alive).
 * A team spawn burst creates several panes back to back; the cap keeps the
 * handshake storm bounded without limiting live sessions.
 */
const DEFAULT_MAX_CONCURRENT_SPAWNS = 5;

/** Positive integer or nothing: a malformed override falls back, never throws. */
export function resolveMaxConcurrentAcpSpawns(
	raw: string | undefined = process.env.SUPERSET_ACP_MAX_CONCURRENT_SPAWNS,
	fallback: number = DEFAULT_MAX_CONCURRENT_SPAWNS,
): number {
	const value = raw?.trim();
	if (value === undefined || value === "") return fallback;
	// Plain decimal digits only: "1e3" and "0x10" parse as numbers but are
	// typos in a config value, not intentions.
	if (!/^\d+$/.test(value)) {
		console.warn(
			`[AcpHost] Ignoring malformed SUPERSET_ACP_MAX_CONCURRENT_SPAWNS="${raw}"; using ${fallback}`,
		);
		return fallback;
	}
	const parsed = Number(value);
	if (parsed < 1) {
		console.warn(
			`[AcpHost] Ignoring SUPERSET_ACP_MAX_CONCURRENT_SPAWNS="${raw}" (must be >= 1); using ${fallback}`,
		);
		return fallback;
	}
	return parsed;
}

class Semaphore {
	private inUse = 0;
	private queue: Array<(release: () => void) => void> = [];

	constructor(private max: number) {}

	acquire(): Promise<() => void> {
		if (this.inUse < this.max) {
			this.inUse++;
			return Promise.resolve(() => this.release());
		}

		return new Promise<() => void>((resolveAcquire) => {
			this.queue.push(resolveAcquire);
		});
	}

	private release(): void {
		this.inUse = Math.max(0, this.inUse - 1);

		const next = this.queue.shift();
		if (next) {
			this.inUse++;
			next(() => this.release());
		}
	}
}

/**
 * Manager for every pane's ACP session.
 *
 * Registry is keyed by `paneId` — callers speak pane ids only, exactly like the
 * terminal stack. The ACP server's own `sessionId` is minted by `session/new`
 * and never leaves `AcpSession` except as a read-only field on
 * `AcpSessionInfo`.
 *
 * Events are per-pane namespaced: `update:${paneId}`, `exit:${paneId}`,
 * `error:${paneId}` (see `AcpHostEvents`).
 */
export class AcpHost extends EventEmitter {
	private sessions = new Map<string, AcpSession>();
	private pendingSessions = new Map<string, Promise<AcpSessionInfo>>();
	private spawnLimiter = new Semaphore(resolveMaxConcurrentAcpSpawns());

	/**
	 * Idempotent per pane: a second call while the first is still starting
	 * returns that same pending promise, and a call for a live pane returns its
	 * current info rather than spawning a second child.
	 */
	createSession(options: AcpSessionOptions): Promise<AcpSessionInfo> {
		const { paneId } = options;

		const pending = this.pendingSessions.get(paneId);
		if (pending) return pending;

		const existing = this.sessions.get(paneId);
		if (existing) return Promise.resolve(existing.info());

		const startup = this.startSession(options).finally(() => {
			this.pendingSessions.delete(paneId);
		});
		this.pendingSessions.set(paneId, startup);
		return startup;
	}

	private async startSession(
		options: AcpSessionOptions,
	): Promise<AcpSessionInfo> {
		const { paneId } = options;
		const session = new AcpSession(options, {
			onUpdate: (update) => {
				if (DEBUG_ACP) {
					console.log(`[AcpHost] update for ${paneId}: ${update.kind}`);
				}
				this.emit(`update:${paneId}`, update);
			},
			onError: (err) => {
				console.error(`[AcpHost] session error for ${paneId}: ${err.message}`);
				this.emit(`error:${paneId}`, err);
			},
			onExit: (info) => {
				if (this.sessions.get(paneId) === session) {
					this.sessions.delete(paneId);
				}
				this.emit(`exit:${paneId}`, info);
			},
		});

		const releaseSpawn = await this.spawnLimiter.acquire();
		try {
			const info = await session.start();
			this.sessions.set(paneId, session);
			return info;
		} finally {
			releaseSpawn();
		}
	}

	/**
	 * Resolves when the turn ends, with the `stopReason`. Streamed content
	 * arrives as `update:${paneId}` events, not through the return value.
	 */
	async prompt(paneId: string, text: string): Promise<AcpPromptResult> {
		return this.requireSession(paneId).prompt(text);
	}

	/** Cancels the in-flight turn. Resolves as a no-op when the pane is idle. */
	async cancel(paneId: string): Promise<void> {
		const session = this.sessions.get(paneId);
		if (!session) return;
		await session.cancel();
	}

	/**
	 * Validates against the cached declaration first and throws
	 * `acp-invalid-config-value` without sending anything — the adapter accepts
	 * illegal values and silently downgrades them, so its success means nothing.
	 */
	async setConfigOption(
		paneId: string,
		optionId: string,
		value: string,
	): Promise<void> {
		await this.requireSession(paneId).setConfigOption(optionId, value);
	}

	async setMode(paneId: string, modeId: string): Promise<void> {
		await this.requireSession(paneId).setMode(modeId);
	}

	getSessionInfo(paneId: string): AcpSessionInfo | undefined {
		return this.sessions.get(paneId)?.info();
	}

	listSessions(): AcpSessionInfo[] {
		return Array.from(this.sessions.values(), (session) => session.info());
	}

	/** Full teardown ladder. Idempotent, and never throws for "already gone". */
	async disposeSession(paneId: string): Promise<void> {
		const session = this.sessions.get(paneId);
		if (!session) return;

		try {
			await session.dispose();
		} catch (error) {
			console.warn(`[AcpHost] dispose failed for ${paneId}:`, error);
		} finally {
			if (this.sessions.get(paneId) === session) {
				this.sessions.delete(paneId);
			}
			this.removeAllListeners(`update:${paneId}`);
			this.removeAllListeners(`exit:${paneId}`);
			this.removeAllListeners(`error:${paneId}`);
		}
	}

	/** Parallel `disposeSession` over the whole registry; used at shutdown. */
	async disposeAll(): Promise<void> {
		const paneIds = Array.from(this.sessions.keys());
		await Promise.all(paneIds.map((paneId) => this.disposeSession(paneId)));
	}

	private requireSession(paneId: string): AcpSession {
		const session = this.sessions.get(paneId);
		if (!session) {
			throw acpError(
				"acp-session-not-found",
				`no ACP session for pane ${paneId}`,
			);
		}
		return session;
	}
}

let acpHost: AcpHost | null = null;

export function getAcpHost(): AcpHost {
	if (!acpHost) {
		acpHost = new AcpHost();
	}
	return acpHost;
}
