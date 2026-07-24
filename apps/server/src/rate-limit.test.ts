import { beforeEach, describe, expect, it } from "bun:test";
import type { IncomingMessage } from "node:http";
import { _resetRateLimit, isLockedOut, recordAuthResult } from "./rate-limit";

function reqFrom(ip: string): IncomingMessage {
	return {
		headers: {},
		socket: { remoteAddress: ip },
	} as unknown as IncomingMessage;
}

describe("failed-auth rate limiter", () => {
	beforeEach(() => _resetRateLimit());

	it("locks out after 10 consecutive failures", () => {
		const req = reqFrom("10.0.0.1");
		for (let i = 0; i < 9; i++) {
			expect(isLockedOut(req)).toBe(false);
			recordAuthResult(req, false);
		}
		expect(isLockedOut(req)).toBe(false); // 9 failures, still allowed
		recordAuthResult(req, false); // 10th
		expect(isLockedOut(req)).toBe(true);
	});

	it("a success clears the failure counter", () => {
		const req = reqFrom("10.0.0.2");
		for (let i = 0; i < 9; i++) recordAuthResult(req, false);
		recordAuthResult(req, true); // clears
		for (let i = 0; i < 9; i++) recordAuthResult(req, false);
		expect(isLockedOut(req)).toBe(false); // counter was reset, only 9 again
	});

	it("lockout expires after the window", () => {
		const req = reqFrom("10.0.0.3");
		const t0 = 1_000_000;
		for (let i = 0; i < 10; i++) recordAuthResult(req, false, t0);
		expect(isLockedOut(req, t0)).toBe(true);
		expect(isLockedOut(req, t0 + 61_000)).toBe(false); // window passed
	});

	it("tracks IPs independently", () => {
		const a = reqFrom("10.0.0.4");
		const b = reqFrom("10.0.0.5");
		for (let i = 0; i < 10; i++) recordAuthResult(a, false);
		expect(isLockedOut(a)).toBe(true);
		expect(isLockedOut(b)).toBe(false);
	});

	it("honors X-Forwarded-For (proxy front end)", () => {
		const viaProxy = {
			headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
			socket: { remoteAddress: "10.0.0.1" },
		} as unknown as IncomingMessage;
		for (let i = 0; i < 10; i++) recordAuthResult(viaProxy, false);
		expect(isLockedOut(viaProxy)).toBe(true);
		// A different forwarded client from the same proxy socket is separate.
		const other = {
			headers: { "x-forwarded-for": "203.0.113.10" },
			socket: { remoteAddress: "10.0.0.1" },
		} as unknown as IncomingMessage;
		expect(isLockedOut(other)).toBe(false);
	});
});
