// Moved to packages/server-core (Phase 1 extraction). This shim carries the
// desktop-side host wiring: the encrypted key store into buildTerminalEnv,
// and analytics/UI-state/DB into the terminal manager hooks. It lives here
// (main-only) rather than in the package, which is also loaded by the
// terminal-host subprocess and must stay free of localDb/electron.
import { setOpenRouterKeyResolver } from "@ade/server-core/terminal/env";
import { setTerminalManagerHooks } from "@ade/server-core/terminal/host-hooks";
import { workspaces } from "@superset/local-db";
import { track } from "main/lib/analytics";
import { appState } from "main/lib/app-state";
import { localDb } from "main/lib/local-db";
import { getProviderKey } from "main/lib/provider-keys";

setOpenRouterKeyResolver(() => getProviderKey("openrouter"));

setTerminalManagerHooks({
	track,
	getFocusState: () => {
		const tabsState = appState.data?.tabsState;
		if (!tabsState) return undefined;
		return {
			activeTabIds: tabsState.activeTabIds,
			focusedPaneIds: tabsState.focusedPaneIds,
		};
	},
	listWorkspaceIds: () =>
		localDb
			.select({ id: workspaces.id })
			.from(workspaces)
			.all()
			.map((w) => w.id),
});

export * from "@ade/server-core/terminal";
