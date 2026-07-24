/**
 * True when the renderer is running in a browser against ade-server
 * (apps/webui installs a preload shim with `platform: "web"`), false in the
 * Electron desktop shell. Used to gate web-only behavior — e.g. re-attaching
 * terminals after iOS Safari suspends background WebSockets — without
 * touching the desktop experience.
 */
export function isWebShell(): boolean {
	if (typeof window === "undefined") return false;
	const app = window.App as { platform?: string } | undefined;
	return app?.platform === "web";
}
