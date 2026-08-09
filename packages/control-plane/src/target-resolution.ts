import { ControlError } from "./protocol";
import {
	type ControlPlaneSnapshot,
	focusedPaneId,
	focusedTabId,
	panesForTabInOrder,
	tabsForWorkspace,
} from "./snapshot";

/**
 * Server-side target resolution. The CLI never resolves — it forwards the
 * string the user typed and main turns it into an id.
 *
 * Accepted forms (PROTOCOL.md § Target resolution):
 *   - a UUID (or any id that exists in the snapshot)
 *   - `workspace:<n>` / `tab:<n>` / `pane:<n>`, 1-based position in the
 *     CURRENT UI order at resolution time — deliberately not stable across
 *     layout changes, and documented as such in CLI help
 *   - `focused`
 *
 * A ref of the wrong kind for the command is a BAD_REQUEST, not a NOT_FOUND:
 * `close-pane workspace:2` is a mistake in the request, not a missing target.
 */
export type TargetKind = "pane" | "tab" | "workspace";

const REF_PATTERN = /^(workspace|tab|pane):(\d+)$/;

function parsePosition(raw: string): number {
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1) {
		throw new ControlError(
			"BAD_REQUEST",
			`Ref position must be a positive 1-based integer, got "${raw}"`,
		);
	}
	return n;
}

function nth<T>(items: T[], position: number, what: string): T {
	const item = items[position - 1];
	if (!item) {
		throw new ControlError(
			"NOT_FOUND",
			`No ${what} at position ${position} (${items.length} present)`,
		);
	}
	return item;
}

export function resolveTarget(
	snapshot: ControlPlaneSnapshot,
	kind: TargetKind,
	target: unknown,
): string {
	if (typeof target !== "string" || target.trim().length === 0) {
		throw new ControlError("BAD_REQUEST", `Missing ${kind} target`);
	}
	const value = target.trim();

	if (value === "focused") {
		const resolved = resolveFocused(snapshot, kind);
		if (!resolved) {
			throw new ControlError("NOT_FOUND", `No focused ${kind}`);
		}
		return resolved;
	}

	const refMatch = REF_PATTERN.exec(value);
	if (refMatch?.[1] && refMatch[2]) {
		const refKind = refMatch[1] as TargetKind;
		if (refKind !== kind) {
			throw new ControlError(
				"BAD_REQUEST",
				`Expected a ${kind} target, got a ${refKind} ref ("${value}")`,
			);
		}
		return resolveRef(snapshot, kind, parsePosition(refMatch[2]));
	}

	// Anything else is treated as an id and must exist.
	if (existsById(snapshot, kind, value)) return value;
	throw new ControlError("NOT_FOUND", `No ${kind} with id "${value}"`);
}

function resolveFocused(
	snapshot: ControlPlaneSnapshot,
	kind: TargetKind,
): string | null {
	switch (kind) {
		case "workspace":
			return snapshot.focusedWorkspaceId;
		case "tab":
			return focusedTabId(snapshot);
		case "pane":
			return focusedPaneId(snapshot);
	}
}

function resolveRef(
	snapshot: ControlPlaneSnapshot,
	kind: TargetKind,
	position: number,
): string {
	switch (kind) {
		case "workspace":
			return nth(snapshot.workspaceOrder, position, "workspace");
		case "tab": {
			const workspaceId = snapshot.focusedWorkspaceId;
			if (!workspaceId) {
				throw new ControlError(
					"NOT_FOUND",
					"tab:<n> needs a focused workspace to count within, and none is focused",
				);
			}
			return nth(tabsForWorkspace(snapshot, workspaceId), position, "tab").id;
		}
		case "pane": {
			const tabId = focusedTabId(snapshot);
			if (!tabId) {
				throw new ControlError(
					"NOT_FOUND",
					"pane:<n> needs a focused tab to count within, and none is focused",
				);
			}
			return nth(panesForTabInOrder(snapshot, tabId), position, "pane").id;
		}
	}
}

function existsById(
	snapshot: ControlPlaneSnapshot,
	kind: TargetKind,
	id: string,
): boolean {
	switch (kind) {
		case "workspace":
			return snapshot.workspaceOrder.includes(id);
		case "tab":
			return snapshot.tabs.some((t) => t.id === id);
		case "pane":
			return Boolean(snapshot.panes[id]);
	}
}
