/**
 * Web implementation of the Electron preload surface (PHASE_2.md §3).
 * Installed before the renderer boots. Anything genuinely desktop-only
 * no-ops; capability flags let the UI hide those affordances over time.
 */

const noop = () => {};

const appShim = new Proxy(
	{
		// Known fields the renderer reads at boot.
		platform: "web",
		isPackaged: true,
	} as Record<string | symbol, unknown>,
	{
		get(target, prop) {
			if (prop in target) return target[prop];
			// Unknown member: return a no-op function so calls don't crash.
			return noop;
		},
	},
);

const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

const ipcRendererShim = {
	on(channel: string, fn: (...args: unknown[]) => void) {
		let set = listeners.get(channel);
		if (!set) {
			set = new Set();
			listeners.set(channel, set);
		}
		set.add(fn);
	},
	off(channel: string, fn: (...args: unknown[]) => void) {
		listeners.get(channel)?.delete(fn);
	},
	removeListener(channel: string, fn: (...args: unknown[]) => void) {
		listeners.get(channel)?.delete(fn);
	},
	send: noop,
	invoke: async () => undefined,
};

const webUtilsShim = {
	// Browsers don't expose real paths; uploads go through explicit pickers.
	getPathForFile: () => "",
};

declare global {
	interface Window {
		App: typeof appShim;
		ipcRenderer: typeof ipcRendererShim;
		webUtils: typeof webUtilsShim;
	}
}

export function installWebShell(): void {
	window.App ??= appShim;
	window.ipcRenderer ??= ipcRendererShim;
	window.webUtils ??= webUtilsShim;
}

installWebShell();
