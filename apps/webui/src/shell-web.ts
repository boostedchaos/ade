/**
 * Web implementation of the Electron preload surface (PHASE_2.md §3).
 * Installed before the renderer boots. Anything genuinely desktop-only
 * no-ops; capability flags let the UI hide those affordances over time.
 */

const noop = () => {};

declare const __APP_VERSION__: string;

/**
 * The subset of the Electron preload surface the shared renderer actually
 * reads. Declared explicitly rather than inferred from the Proxy: the renderer
 * is compiled by BOTH apps, so a member typed `unknown` here (which is what a
 * `Record<string, unknown>` Proxy infers) is a type error at every desktop
 * call site even though the desktop preload types it precisely.
 */
interface AppShim {
	platform: string;
	isPackaged: boolean;
	appVersion: string;
	[key: string]: unknown;
}

const appShim = new Proxy(
	{
		// Known fields the renderer reads at boot.
		platform: "web",
		isPackaged: true,
		appVersion: __APP_VERSION__,
	} as AppShim,
	{
		get(target, prop) {
			if (prop in target) return target[prop as string];
			// Unknown member: return a no-op function so calls don't crash.
			return noop;
		},
	},
);

const listeners = new Map<string, Set<IpcListener>>();

/**
 * Signature-compatible with the desktop preload's listener type. The payload
 * is `unknown` on purpose — a listener that wants a narrower shape must
 * validate it, because on the desktop side these arguments cross an IPC
 * boundary from the main process.
 */
type IpcListener = (...args: unknown[]) => void;

const ipcRendererShim = {
	on(channel: string, fn: IpcListener) {
		let set = listeners.get(channel);
		if (!set) {
			set = new Set();
			listeners.set(channel, set);
		}
		set.add(fn);
	},
	off(channel: string, fn: IpcListener) {
		listeners.get(channel)?.delete(fn);
	},
	removeListener(channel: string, fn: IpcListener) {
		listeners.get(channel)?.delete(fn);
	},
	// Both take (channel, ...args) like the preload does. Typing them as bare
	// no-ops made every real call site an "expected 0 arguments" error.
	send: (_channel: string, ..._args: unknown[]): void => {},
	invoke: async (_channel: string, ..._args: unknown[]): Promise<unknown> =>
		undefined,
};

const webUtilsShim = {
	// Browsers don't expose real paths; uploads go through explicit pickers.
	getPathForFile: (_file: File): string => "",
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
