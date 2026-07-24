import { describe, expect, it } from "bun:test";
import { WRITER_LEASE_GRACE_MS, WriterLeaseRegistry } from "./writer-lease";

const PANE = "pane-1";
const A = "client-a";
const B = "client-b";

describe("writer lease (multi-device attach policy)", () => {
	it("first attach becomes the writer, concurrent attach mirrors", () => {
		const leases = new WriterLeaseRegistry();
		expect(leases.attach(PANE, A)).toEqual({ readOnly: false });
		expect(leases.attach(PANE, B)).toEqual({ readOnly: true });
		// Idempotent for the holder.
		expect(leases.attach(PANE, A)).toEqual({ readOnly: false });
	});

	it("writer writes pass, mirror writes are denied", () => {
		const leases = new WriterLeaseRegistry();
		leases.attach(PANE, A);
		leases.attach(PANE, B);
		expect(leases.allowWrite(PANE, A)).toBe(true);
		expect(leases.allowWrite(PANE, B)).toBe(false);
		expect(leases.isReadOnly(PANE, A)).toBe(false);
		expect(leases.isReadOnly(PANE, B)).toBe(true);
	});

	it("calls without a clientId never participate and never block", () => {
		const leases = new WriterLeaseRegistry();
		expect(leases.allowWrite(PANE, undefined)).toBe(true);
		// Anonymous write did not acquire the lease.
		expect(leases.attach(PANE, B)).toEqual({ readOnly: false });
		expect(leases.allowWrite(PANE, undefined)).toBe(true);
	});

	it("dropping the writer's last subscription frees the lease; reconnect regains write", () => {
		const leases = new WriterLeaseRegistry();
		leases.attach(PANE, A);
		const unbind = leases.bindSubscription(PANE, A);
		leases.attach(PANE, B);
		expect(leases.isReadOnly(PANE, B)).toBe(true);

		unbind(); // WS drop / tab close

		// A fresh page load (new clientId) attaches and gets write back.
		expect(leases.attach(PANE, "client-a2")).toEqual({ readOnly: false });
	});

	it("a freed pane is acquired by the first write (last-free-wins)", () => {
		const leases = new WriterLeaseRegistry();
		leases.attach(PANE, A);
		const unbindA = leases.bindSubscription(PANE, A);
		leases.attach(PANE, B);
		leases.bindSubscription(PANE, B);

		unbindA();
		// Pane is free — the mirror's next keystroke takes the lease.
		expect(leases.isReadOnly(PANE, B)).toBe(false);
		expect(leases.allowWrite(PANE, B)).toBe(true);
		expect(leases.isReadOnly(PANE, B)).toBe(false);
		expect(leases.attach(PANE, A)).toEqual({ readOnly: true });
	});

	it("grace window: holder without a bound subscription is not stealable yet", () => {
		const t0 = 1_000_000;
		const leases = new WriterLeaseRegistry();
		leases.attach(PANE, A, t0);
		// Within the grace window (attach happened, WS not bound yet).
		expect(leases.attach(PANE, B, t0 + 1_000)).toEqual({ readOnly: true });
		// After the grace window with no live subscription, the holder is
		// stale and the lease transfers.
		expect(leases.attach(PANE, B, t0 + WRITER_LEASE_GRACE_MS + 1)).toEqual({
			readOnly: false,
		});
		expect(leases.allowWrite(PANE, A, t0 + WRITER_LEASE_GRACE_MS + 2)).toBe(
			false,
		);
	});

	it("a live subscription keeps the holder alive past the grace window", () => {
		const t0 = 1_000_000;
		const leases = new WriterLeaseRegistry();
		leases.attach(PANE, A, t0);
		leases.bindSubscription(PANE, A);
		expect(leases.attach(PANE, B, t0 + WRITER_LEASE_GRACE_MS * 10)).toEqual({
			readOnly: true,
		});
	});

	it("takeOver transfers the lease on explicit user action", () => {
		const leases = new WriterLeaseRegistry();
		leases.attach(PANE, A);
		leases.bindSubscription(PANE, A);
		leases.attach(PANE, B);

		leases.takeOver(PANE, B);
		expect(leases.allowWrite(PANE, B)).toBe(true);
		expect(leases.allowWrite(PANE, A)).toBe(false);
		expect(leases.isReadOnly(PANE, A)).toBe(true);
	});

	it("notifies bound subscriptions on lease changes", () => {
		const leases = new WriterLeaseRegistry();
		const events: Array<{ client: string; readOnly: boolean }> = [];
		leases.attach(PANE, A);
		const unbindA = leases.bindSubscription(PANE, A, () =>
			events.push({ client: A, readOnly: leases.isReadOnly(PANE, A) }),
		);
		leases.attach(PANE, B);
		leases.bindSubscription(PANE, B, () =>
			events.push({ client: B, readOnly: leases.isReadOnly(PANE, B) }),
		);

		leases.takeOver(PANE, B);
		expect(events).toEqual([
			{ client: A, readOnly: true },
			{ client: B, readOnly: false },
		]);

		events.length = 0;
		unbindA(); // demoted client leaves — no lease change, no events
		expect(events).toEqual([]);
	});

	it("release() on detach frees the lease only for the holder", () => {
		const leases = new WriterLeaseRegistry();
		leases.attach(PANE, A);
		leases.bindSubscription(PANE, A);
		leases.release(PANE, B); // mirror detaching changes nothing
		expect(leases.attach(PANE, B)).toEqual({ readOnly: true });
		leases.release(PANE, A);
		expect(leases.attach(PANE, B)).toEqual({ readOnly: false });
	});

	it("clear() on kill wipes the lease", () => {
		const leases = new WriterLeaseRegistry();
		leases.attach(PANE, A);
		leases.bindSubscription(PANE, A);
		leases.clear(PANE);
		expect(leases.attach(PANE, B)).toEqual({ readOnly: false });
	});

	it("resize from a mirror is denied but never steals the lease", () => {
		const t0 = 1_000_000;
		const leases = new WriterLeaseRegistry();
		leases.attach(PANE, A, t0);
		leases.bindSubscription(PANE, A);
		expect(leases.allowResize(PANE, B, t0)).toBe(false);
		expect(leases.allowResize(PANE, A, t0)).toBe(true);

		// Free pane: resize passes but does not acquire.
		const free = new WriterLeaseRegistry();
		expect(free.allowResize(PANE, B, t0)).toBe(true);
		expect(free.attach(PANE, A, t0)).toEqual({ readOnly: false });
	});

	it("tracks panes independently", () => {
		const leases = new WriterLeaseRegistry();
		leases.attach("pane-1", A);
		leases.bindSubscription("pane-1", A);
		expect(leases.attach("pane-2", B)).toEqual({ readOnly: false });
		expect(leases.allowWrite("pane-2", B)).toBe(true);
		expect(leases.allowWrite("pane-1", B)).toBe(false);
	});

	it("double unbind is safe and multiple subs from one client refcount", () => {
		const leases = new WriterLeaseRegistry();
		leases.attach(PANE, A);
		const unbind1 = leases.bindSubscription(PANE, A);
		const unbind2 = leases.bindSubscription(PANE, A);
		unbind1();
		unbind1(); // no-op
		// Still one live subscription — holder stays live.
		expect(leases.attach(PANE, B)).toEqual({ readOnly: true });
		unbind2();
		expect(leases.attach(PANE, B)).toEqual({ readOnly: false });
	});
});
