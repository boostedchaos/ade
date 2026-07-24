/**
 * Multi-device attach policy (PHASE_4 §3, issue #7): mirror-readonly v1.
 *
 * Every browser page load identifies itself with a `clientId` (a per-load
 * UUID minted by the renderer). Per pane, the first client to attach holds
 * the *writer lease*; concurrent attaches from other clients get a live
 * read-only mirror of the stream. Enforcement lives here, at the server
 * router layer — the daemon itself keeps fanning out output to everyone.
 *
 * Lease lifecycle:
 * - Granted on `createOrAttach` when the pane is free (or the holder is
 *   stale), and implicitly on `write` against a free pane.
 * - Liveness is tied to the holder's `terminal.stream` WS subscription:
 *   when the holder's last live subscription for the pane tears down
 *   (socket drop, tab close, unmount), the lease is released immediately —
 *   so a refreshed page (fresh clientId) re-attaches and regains write.
 * - A short grace window after grant/last activity covers the gap between
 *   `createOrAttach` (HTTP) and the stream subscription binding (WS), so a
 *   concurrent attacher can't steal the lease in between.
 * - `takeWriter` is an explicit, last-writer-wins transfer (user action on
 *   a mirrored client); the demoted client learns via a `mode` event.
 * - Calls without a clientId (bootstrap scripts, older clients, the smoke
 *   test) don't participate: they neither hold nor are blocked by leases.
 *   The desktop Electron app uses its own in-process router and never
 *   reaches this policy at all.
 */

export const WRITER_LEASE_GRACE_MS = 15_000;

interface PaneLeaseState {
	/** Current writer's clientId, or null when the pane is up for grabs. */
	holder: string | null;
	/** Last grant/write/attach from the holder — drives the grace window. */
	lastActivityAt: number;
	/** Live stream-subscription count per clientId. */
	subs: Map<string, number>;
	/** Notified on any lease change (grant/release/transfer). */
	listeners: Set<() => void>;
}

export class WriterLeaseRegistry {
	private panes = new Map<string, PaneLeaseState>();

	constructor(private graceMs: number = WRITER_LEASE_GRACE_MS) {}

	private pane(paneId: string): PaneLeaseState {
		let p = this.panes.get(paneId);
		if (!p) {
			p = {
				holder: null,
				lastActivityAt: 0,
				subs: new Map(),
				listeners: new Set(),
			};
			this.panes.set(paneId, p);
		}
		return p;
	}

	/** Drop empty per-pane state so dead paneIds don't accumulate. */
	private gc(paneId: string, p: PaneLeaseState): void {
		if (!p.holder && p.subs.size === 0 && p.listeners.size === 0) {
			this.panes.delete(paneId);
		}
	}

	private holderIsLive(p: PaneLeaseState, now: number): boolean {
		if (!p.holder) return false;
		if ((p.subs.get(p.holder) ?? 0) > 0) return true;
		return now - p.lastActivityAt < this.graceMs;
	}

	private grant(p: PaneLeaseState, clientId: string, now: number): void {
		const changed = p.holder !== clientId;
		p.holder = clientId;
		p.lastActivityAt = now;
		if (changed) this.notify(p);
	}

	private notify(p: PaneLeaseState): void {
		for (const listener of [...p.listeners]) listener();
	}

	/**
	 * createOrAttach: grant when the pane is free or the holder is stale;
	 * idempotent for the current holder; everyone else mirrors.
	 */
	attach(
		paneId: string,
		clientId: string,
		now = Date.now(),
	): {
		readOnly: boolean;
	} {
		const p = this.pane(paneId);
		if (p.holder === clientId) {
			p.lastActivityAt = now;
			return { readOnly: false };
		}
		if (!this.holderIsLive(p, now)) {
			this.grant(p, clientId, now);
			return { readOnly: false };
		}
		return { readOnly: true };
	}

	/**
	 * Input-shaped calls (write/signal): the holder passes; a free pane is
	 * acquired on first write (last-free-wins after a writer drop); mirrors
	 * are denied. Calls without a clientId always pass (non-participants).
	 */
	allowWrite(
		paneId: string,
		clientId: string | undefined,
		now = Date.now(),
	): boolean {
		if (!clientId) return true;
		const p = this.pane(paneId);
		if (p.holder === clientId) {
			p.lastActivityAt = now;
			return true;
		}
		if (!this.holderIsLive(p, now)) {
			this.grant(p, clientId, now);
			return true;
		}
		return false;
	}

	/** resize: like write, but never acquires the lease (window-resize noise). */
	allowResize(
		paneId: string,
		clientId: string | undefined,
		now = Date.now(),
	): boolean {
		if (!clientId) return true;
		const p = this.pane(paneId);
		if (p.holder === clientId) {
			p.lastActivityAt = now;
			return true;
		}
		return !this.holderIsLive(p, now);
	}

	/** Explicit user takeover — last-writer-wins. */
	takeOver(paneId: string, clientId: string, now = Date.now()): void {
		this.grant(this.pane(paneId), clientId, now);
	}

	/** Explicit detach: the caller gives up the lease if it holds it. */
	release(paneId: string, clientId: string): void {
		const p = this.panes.get(paneId);
		if (!p || p.holder !== clientId) return;
		p.holder = null;
		this.notify(p);
		this.gc(paneId, p);
	}

	/** Session killed: lease cleared regardless of holder. */
	clear(paneId: string): void {
		const p = this.panes.get(paneId);
		if (!p) return;
		if (p.holder) {
			p.holder = null;
			this.notify(p);
		}
		this.gc(paneId, p);
	}

	/** Current mode for a client — drives the stream's `mode` events. */
	isReadOnly(paneId: string, clientId: string, now = Date.now()): boolean {
		const p = this.panes.get(paneId);
		if (!p || p.holder === clientId) return false;
		return this.holderIsLive(p, now);
	}

	/**
	 * Bind a live stream subscription for (paneId, clientId). `onChange`
	 * fires on every lease change so the subscription can re-emit its mode.
	 * The returned unbind releases the lease when the holder's last live
	 * subscription goes away — a dropped socket frees the pane.
	 */
	bindSubscription(
		paneId: string,
		clientId: string,
		onChange?: () => void,
	): () => void {
		const p = this.pane(paneId);
		p.subs.set(clientId, (p.subs.get(clientId) ?? 0) + 1);
		if (onChange) p.listeners.add(onChange);
		let unbound = false;
		return () => {
			if (unbound) return;
			unbound = true;
			if (onChange) p.listeners.delete(onChange);
			const remaining = (p.subs.get(clientId) ?? 1) - 1;
			if (remaining <= 0) p.subs.delete(clientId);
			else p.subs.set(clientId, remaining);
			if (p.holder === clientId && (p.subs.get(clientId) ?? 0) === 0) {
				// Writer's last live subscription is gone — free the lease so a
				// reconnecting page (fresh clientId) regains write immediately.
				p.holder = null;
				this.notify(p);
			}
			this.gc(paneId, p);
		};
	}
}

let registry: WriterLeaseRegistry | null = null;

/** Process-wide singleton used by the terminal router. */
export function getWriterLeaseRegistry(): WriterLeaseRegistry {
	if (!registry) registry = new WriterLeaseRegistry();
	return registry;
}

/** Test helper. */
export function _resetWriterLeases(): void {
	registry = null;
}
