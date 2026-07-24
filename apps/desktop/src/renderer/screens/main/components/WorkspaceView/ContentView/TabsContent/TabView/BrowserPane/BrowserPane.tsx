import { isWebShell } from "renderer/lib/is-web-shell";
import { BrowserPaneDesktop } from "./BrowserPaneDesktop";
import { BrowserPaneWeb } from "./BrowserPaneWeb";
import type { BrowserPaneProps } from "./types";

/**
 * Dispatches between the Electron-backed desktop implementation and the web
 * fallback. The desktop pane depends on Electron's native `<webview>` tag and
 * the Electron-only `electronTrpc.browser` router, neither of which functions
 * in a plain browser — see BrowserPaneWeb. The two are separate components (not
 * a conditional inside one) so each mounts a stable, consistent set of hooks.
 */
export function BrowserPane(props: BrowserPaneProps) {
	if (isWebShell()) {
		return <BrowserPaneWeb {...props} />;
	}
	return <BrowserPaneDesktop {...props} />;
}
