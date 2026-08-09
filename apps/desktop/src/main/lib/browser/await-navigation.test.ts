import { describe, expect, it } from "bun:test";
import { awaitNavigation } from "./await-navigation";

const later = <T>(ms: number, value: T): Promise<T> =>
	new Promise((resolve) => setTimeout(() => resolve(value), ms));

const rejectLater = (ms: number, err: Error): Promise<never> =>
	new Promise((_resolve, reject) => setTimeout(() => reject(err), ms));

describe("awaitNavigation", () => {
	/**
	 * The behaviour the control-plane `browser navigate` was missing entirely:
	 * `loadURL` was called and its promise dropped, so the command reported
	 * success while the page was still loading and a following `evaluate` ran
	 * against the previous document. This asserts the wait actually spans the
	 * load rather than returning first.
	 */
	it("does not resolve before the load settles", async () => {
		let settled = false;
		const load = later(40, "ok").then((v) => {
			settled = true;
			return v;
		});
		await awaitNavigation(load, "https://example.com", 1_000);
		expect(settled).toBe(true);
	});

	it("propagates a failed load as an error", async () => {
		await expect(
			awaitNavigation(
				rejectLater(5, new Error("ERR_NAME_NOT_RESOLVED")),
				"https://nope.invalid",
				1_000,
			),
		).rejects.toThrow("ERR_NAME_NOT_RESOLVED");
	});

	it("gives up after the timeout on a load that never settles", async () => {
		await expect(
			awaitNavigation(new Promise(() => {}), "https://hang.example", 20),
		).rejects.toThrow("did not settle in 20ms");
	});

	it("names the url and the budget in the timeout message", async () => {
		await expect(
			awaitNavigation(new Promise(() => {}), "https://hang.example", 15),
		).rejects.toThrow("https://hang.example");
	});

	it("clears its timer once the load resolves", async () => {
		// A leaked 30 s timer per navigation would hold the main process's event
		// loop open; if the timer survived, this test would not exit promptly.
		const before = process.getActiveResourcesInfo?.().length ?? 0;
		await awaitNavigation(Promise.resolve("ok"), "https://example.com", 30_000);
		const after = process.getActiveResourcesInfo?.().length ?? 0;
		expect(after).toBeLessThanOrEqual(before);
	});
});
