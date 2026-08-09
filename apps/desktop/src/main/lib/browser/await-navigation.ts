/**
 * Bounded wait for a navigation to settle.
 *
 * Split out of `browser-manager.ts` so it can be tested: that module imports
 * `electron` at load time, which no unit test can provide.
 */

/** Upper bound on how long a navigate command waits for a load to settle. */
export const NAVIGATE_TIMEOUT_MS = 30_000;

/**
 * Resolve when `load` settles, reject if it fails, and give up after
 * `timeoutMs`.
 *
 * Electron's `loadURL` resolves on `did-finish-load` and rejects on
 * `did-fail-load`, so awaiting it is what makes a navigate command mean "the
 * page is there" rather than "the request was posted". The timeout covers the
 * third case it does NOT report — a server that accepts the connection and
 * then holds it open, where neither event ever fires. Timing out abandons the
 * WAIT, not the navigation: the page may still arrive afterwards.
 */
export async function awaitNavigation(
	load: Promise<unknown>,
	url: string,
	timeoutMs: number = NAVIGATE_TIMEOUT_MS,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(`Navigation to ${url} did not settle in ${timeoutMs}ms`),
				),
			timeoutMs,
		);
	});

	try {
		await Promise.race([load, timeout]);
	} finally {
		// Without this the timer keeps the event loop alive for the full
		// duration after a fast load, which in the main process is a leak per
		// navigation rather than a one-off.
		if (timer) clearTimeout(timer);
	}
}
