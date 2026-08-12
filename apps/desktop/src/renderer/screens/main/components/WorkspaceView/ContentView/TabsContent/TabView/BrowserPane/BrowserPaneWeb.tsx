import { toast } from "@superset/ui/sonner";
import { MonitorSmartphoneIcon } from "lucide-react";
import { useCallback } from "react";
import { BasePaneWindow, PaneToolbarActions } from "../components";
import { BrowserToolbar } from "./components/BrowserToolbar";
import { DEFAULT_BROWSER_URL } from "./constants";
import type { BrowserPaneProps } from "./types";

const DESKTOP_ONLY_MESSAGE = "Browser pane is desktop-only for now";

/**
 * Web fallback for the Browser pane. The desktop pane is built on Electron's
 * native `<webview>` tag and the Electron-only `electronTrpc.browser` router,
 * neither of which exists in a plain browser. Rather than silently eating URL
 * entry (the old behavior — `webview.loadURL` on an inert element was a no-op),
 * this renders a clear "desktop-only" state and surfaces a toast on any
 * navigation attempt so typing a URL always produces visible feedback.
 */
export function BrowserPaneWeb({
	paneId,
	path,
	tabId,
	splitPaneAuto,
	removePane,
	setFocusedPane,
}: BrowserPaneProps) {
	const notifyDesktopOnly = useCallback(() => {
		toast.info(DESKTOP_ONLY_MESSAGE, {
			description: "Open this workspace in the desktop app to browse the web.",
		});
	}, []);

	return (
		<BasePaneWindow
			paneId={paneId}
			path={path}
			tabId={tabId}
			splitPaneAuto={splitPaneAuto}
			removePane={removePane}
			setFocusedPane={setFocusedPane}
			renderToolbar={(handlers) => (
				<div className="flex h-full w-full items-center justify-between min-w-0">
					<BrowserToolbar
						currentUrl={DEFAULT_BROWSER_URL}
						pageTitle=""
						isLoading={false}
						canGoBack={false}
						canGoForward={false}
						onGoBack={notifyDesktopOnly}
						onGoForward={notifyDesktopOnly}
						onReload={notifyDesktopOnly}
						onNavigate={notifyDesktopOnly}
					/>
					<div className="flex items-center shrink-0">
						<div className="mx-1.5 h-3.5 w-px bg-muted-foreground/60" />
						<PaneToolbarActions
							splitOrientation={handlers.splitOrientation}
							onSplitPane={handlers.onSplitPane}
							onClosePane={handlers.onClosePane}
							closeHotkeyId="CLOSE_TERMINAL"
						/>
					</div>
				</div>
			)}
		>
			<div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background p-6 text-center">
				<MonitorSmartphoneIcon className="size-10 text-muted-foreground/30" />
				<div>
					<p className="text-sm font-medium text-muted-foreground/60">
						{DESKTOP_ONLY_MESSAGE}
					</p>
					<p className="mt-1 max-w-xs text-xs text-muted-foreground/40">
						The Browser pane relies on the desktop app to embed and control web
						pages. Open this workspace in the Argus desktop app to use it.
					</p>
				</div>
			</div>
		</BasePaneWindow>
	);
}
