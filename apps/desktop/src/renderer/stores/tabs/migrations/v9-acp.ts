import type { TabsState } from "../types";

/**
 * Persisted `tabs-storage` schema version.
 *
 * Bumped 8 → 9 by the ACP pane (Phase 2, D3): `Pane` gained an optional `acp`
 * sub-state, and the repo's convention is that persisted pane sub-state gets a
 * version boundary even when the change needs no transform. The boundary is
 * what any FUTURE non-optional change to `acp` migrates from.
 */
export const TABS_STORE_VERSION = 9;

/**
 * v8 → v9. Deliberately an identity: `Pane.acp` is optional, so a v8 pane is
 * already a valid v9 pane and inventing an empty `acp` object for every
 * terminal in the store would be worse than leaving them alone.
 *
 * It exists as a named, exported step rather than an inline no-op so the
 * assertion that v8 state survives the bump is testable, and so the next
 * change to this sub-state has a place to go.
 */
export function migrateTabsV8ToV9(state: TabsState): TabsState {
	return state;
}
