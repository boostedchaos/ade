/**
 * Host-app hooks for the terminal manager layer.
 *
 * The manager needs three things only the host app can provide: analytics,
 * UI focus state (attention routing), and the set of valid workspace ids
 * (orphaned-session cleanup). The Electron app registers real
 * implementations (analytics/appState/localDb); ade-server registers
 * its own; defaults are safe no-ops.
 */

export interface TerminalFocusState {
	activeTabIds?: Record<string, string | null | undefined>;
	focusedPaneIds?: Record<string, string | null | undefined>;
}

export interface TerminalManagerHooks {
	/** Fire-and-forget analytics. */
	track(event: string, properties?: Record<string, unknown>): void;
	/** Current UI focus state, or undefined when the host has none. */
	getFocusState(): TerminalFocusState | undefined;
	/**
	 * Valid workspace ids for orphaned-session cleanup. Return null when
	 * unknown — cleanup is SKIPPED then; an empty array means "kill
	 * everything", so never default to it.
	 */
	listWorkspaceIds(): string[] | null;
}

let hooks: TerminalManagerHooks = {
	track: () => {},
	getFocusState: () => undefined,
	listWorkspaceIds: () => null,
};

export function setTerminalManagerHooks(next: TerminalManagerHooks): void {
	hooks = next;
}

export function getTerminalManagerHooks(): TerminalManagerHooks {
	return hooks;
}
