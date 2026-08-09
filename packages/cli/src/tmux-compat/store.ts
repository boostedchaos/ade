/**
 * Mapping state for the tmux shim: tmux ids (`%N` pane, `@N` window, `$N`
 * session) ↔ ADE paneId / tabId, plus names, counters and stored options.
 *
 * Every shim invocation is a separate one-shot process (the probe shows
 * `execFile("tmux", argv)` per call), so the file IS the shared state and two
 * invocations can overlap. Two protections:
 *
 * 1. An advisory lock (`O_EXCL` create of a lockfile — atomic on POSIX and on
 *    win32) held for the WHOLE command, so a read-modify-write that spans a
 *    control-plane round trip cannot interleave with another shim process.
 * 2. Atomic publication: write a temp file, then rename over the store, so a
 *    crash mid-write can never leave a truncated JSON document behind.
 */
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAdeDirName } from "../socket-path";

export interface PaneRecord {
	id: string;
	windowId: string;
	/** null until bound; resolved to the control plane's `focused` when absent. */
	adePaneId: string | null;
	title: string | null;
	options: Record<string, string>;
	/**
	 * `shell` — the pane is running its placeholder shell and `respawn-pane`
	 * can type an `exec` into it. `execed` — the shell has been replaced, so a
	 * further respawn must recreate the pane (see translate.ts respawnPane).
	 */
	state: "shell" | "execed";
	command: string | null;
}

export interface WindowRecord {
	id: string;
	sessionId: string;
	name: string;
	adeTabId: string | null;
	options: Record<string, string>;
	paneOrder: string[];
}

export interface SessionRecord {
	id: string;
	name: string;
	windowOrder: string[];
}

export interface StoreData {
	version: 1;
	counters: { pane: number; window: number; session: number };
	sessions: Record<string, SessionRecord>;
	windows: Record<string, WindowRecord>;
	panes: Record<string, PaneRecord>;
	globalOptions: Record<string, string>;
	environment: Record<string, string>;
}

export const STORE_FILENAME = "tmux-compat-store.json";
export const LOCK_FILENAME = "tmux-compat-store.lock";
export const LOG_FILENAME = "tmux-compat.log";

/**
 * A lock older than this MAY belong to a process that died — but age alone is
 * not evidence, so `acquire` also verifies the owning pid is gone before
 * reclaiming it. See `ownerIsDead`.
 */
const STALE_LOCK_MS = 30_000;
const LOCK_TIMEOUT_MS = 15_000;

/** Raised when the lock could not be acquired. The shim maps this to exit 1. */
export class LockTimeoutError extends Error {
	constructor(lockPath: string, waitedMs: number) {
		super(
			`tmux-compat: could not acquire ${lockPath} after ${waitedMs}ms — ` +
				"another ade tmux-compat process is holding it.",
		);
		this.name = "LockTimeoutError";
	}
}

export function emptyStore(): StoreData {
	return {
		version: 1,
		counters: { pane: 0, window: 0, session: 0 },
		sessions: {},
		windows: {},
		panes: {},
		globalOptions: {},
		environment: {},
	};
}

export function defaultStoreDir(env: NodeJS.ProcessEnv = process.env): string {
	// The whole env goes to the resolver, not just the workspace name: the
	// data dir is chosen by $ADE_DATA_DIR_NAME first (see getAdeDirName), and
	// passing a bare name would skip that and put the store in a different
	// directory from the control socket.
	return env.ADE_TMUX_COMPAT_DIR ?? join(homedir(), getAdeDirName(env));
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export interface CompatStoreOptions {
	/** How long `acquire` waits before giving up. Overridden in tests. */
	lockTimeoutMs?: number;
	/** How old a lock must be before its owner is even checked. */
	staleLockMs?: number;
}

export class CompatStore {
	readonly dir: string;
	readonly path: string;
	readonly lockPath: string;
	readonly logPath: string;
	private readonly lockTimeoutMs: number;
	private readonly staleLockMs: number;
	private held = false;

	constructor(dir: string, options: CompatStoreOptions = {}) {
		this.dir = dir;
		this.path = join(dir, STORE_FILENAME);
		this.lockPath = join(dir, LOCK_FILENAME);
		this.logPath = join(dir, LOG_FILENAME);
		this.lockTimeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
		this.staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
	}

	/** Reads the store, healing an absent or corrupt file into an empty one. */
	read(): StoreData {
		let raw: string;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch {
			return emptyStore();
		}
		try {
			const parsed = JSON.parse(raw) as Partial<StoreData>;
			if (!parsed || parsed.version !== 1) return emptyStore();
			return { ...emptyStore(), ...parsed } as StoreData;
		} catch {
			// A corrupt store would strand every mapping; starting clean at least
			// lets the next spawn work. Logged by the caller's failure path.
			return emptyStore();
		}
	}

	/** Publishes a new store state atomically (temp file + rename). */
	write(data: StoreData): void {
		mkdirSync(this.dir, { recursive: true });
		const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, this.path);
	}

	/** Appends one NDJSON line to the compat log. Never throws. */
	log(entry: Record<string, unknown>): void {
		try {
			mkdirSync(this.dir, { recursive: true });
			writeFileSync(
				this.logPath,
				`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
				{ flag: "a" },
			);
		} catch {
			// Logging must never be the reason a teammate fails to spawn.
		}
	}

	/**
	 * True when the lockfile names a pid that is no longer running.
	 *
	 * A lock with no readable pid is treated as dead: it was written by a
	 * process that crashed between `open` and `write`, so nobody is coming back
	 * for it. A pid we can see but may not signal (EPERM) is ALIVE — that is a
	 * live process owned by another user, not a corpse.
	 */
	private ownerIsDead(): boolean {
		let pid: number;
		try {
			pid = Number.parseInt(readFileSync(this.lockPath, "utf8").trim(), 10);
		} catch {
			return true;
		}
		if (!Number.isInteger(pid) || pid <= 0) return true;
		try {
			process.kill(pid, 0);
			return false;
		} catch (err) {
			return (err as NodeJS.ErrnoException).code !== "EPERM";
		}
	}

	/**
	 * Acquire the advisory lock, or throw.
	 *
	 * Two rules, both learned from the bug this replaced: a lock is only ever
	 * broken when it is BOTH older than the stale threshold AND owned by a dead
	 * pid, and running out of time is a FAILURE rather than a licence to steal.
	 * The old code broke any lock once the 15 s acquire deadline passed, which —
	 * the deadline being shorter than the 30 s stale threshold — meant a slow
	 * but perfectly live holder got its lock deleted and two writers then ran a
	 * read-modify-write over the same store.
	 */
	private async acquire(): Promise<void> {
		mkdirSync(this.dir, { recursive: true });
		const started = Date.now();
		const deadline = started + this.lockTimeoutMs;
		for (;;) {
			try {
				const fd = openSync(this.lockPath, "wx");
				writeSync(fd, String(process.pid));
				closeSync(fd);
				this.held = true;
				return;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			}

			let age = 0;
			try {
				age = Date.now() - statSync(this.lockPath).mtimeMs;
			} catch {
				// Vanished between open and stat — the holder released it; retry now.
				continue;
			}
			if (age > this.staleLockMs && this.ownerIsDead()) {
				rmSync(this.lockPath, { force: true });
				continue;
			}
			if (Date.now() > deadline) {
				throw new LockTimeoutError(this.lockPath, Date.now() - started);
			}
			// Jitter so two waiters do not retry in lockstep forever.
			await sleep(5 + Math.floor(Math.random() * 15));
		}
	}

	private release(): void {
		if (!this.held) return;
		this.held = false;
		rmSync(this.lockPath, { force: true });
	}

	/**
	 * Runs `fn` with exclusive access. `fn` gets the current state and may await
	 * (a control-plane round trip happens inside); whatever it leaves in `data`
	 * is published atomically on return, including on the throwing path — a
	 * pane created before an error must not be lost from the mapping.
	 */
	async transact<T>(fn: (data: StoreData) => Promise<T> | T): Promise<T> {
		await this.acquire();
		const data = this.read();
		try {
			return await fn(data);
		} finally {
			try {
				this.write(data);
			} finally {
				this.release();
			}
		}
	}
}

/** Allocates the next `%N` / `@N` / `$N` id. */
export function nextId(data: StoreData, kind: "pane" | "window" | "session") {
	const prefix = kind === "pane" ? "%" : kind === "window" ? "@" : "$";
	const value = data.counters[kind];
	data.counters[kind] = value + 1;
	return `${prefix}${value}`;
}
