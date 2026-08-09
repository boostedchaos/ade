import {
	optionalBoolean,
	optionalString,
	requireEnum,
	requireString,
} from "../args";
import type { BridgeOp } from "../host";
import { ControlError } from "../protocol";
import type { CommandRegistry } from "../server";
import { panesForTabInOrder, requirePane } from "../snapshot";
import { resolveTarget } from "../target-resolution";

const PANE_TYPES = ["terminal", "browser", "file-viewer", "devtools"] as const;
const DIRECTIONS = ["left", "right", "up", "down"] as const;

/**
 * Panes / layout group.
 *
 * READS (`list-panes`) are served from main's app-state mirror — no renderer
 * round trip, so they keep working with no window focused and cost one object
 * read. MUTATIONS go through the renderer bridge, because the mosaic layout
 * and pane records are renderer-owned zustand state and the spec's hard rule
 * is to drive them through the EXISTING store actions.
 */
export const paneCommands: CommandRegistry = {
	"list-panes": (session, args) => {
		const snapshot = session.host.getSnapshot();
		const scope = optionalString(args, "tab");
		const tabId = scope
			? resolveTarget(snapshot, "tab", scope)
			: resolveTarget(snapshot, "tab", "focused");

		const focused = snapshot.focusedPaneIds[tabId];
		return {
			tabId,
			panes: panesForTabInOrder(snapshot, tabId).map((pane, index) => ({
				index: index + 1,
				id: pane.id,
				type: pane.type,
				name: pane.userTitle ?? pane.name,
				status: pane.status ?? "idle",
				cwd: pane.cwd ?? null,
				url: pane.url ?? null,
				focused: pane.id === focused,
			})),
		};
	},

	"new-pane": async (session, args) => {
		const snapshot = session.host.getSnapshot();
		const paneType = requireEnum(args, "type", PANE_TYPES, "terminal");
		const direction = requireEnum(args, "direction", DIRECTIONS, "right");

		const sourcePaneId = resolveTarget(
			snapshot,
			"pane",
			optionalString(args, "pane") ?? "focused",
		);
		const sourcePane = requirePane(snapshot, sourcePaneId);
		const tab = snapshot.tabs.find((t) => t.id === sourcePane.tabId);
		if (!tab) {
			throw new ControlError(
				"NOT_FOUND",
				`Pane ${sourcePaneId} has no tab in the current state`,
			);
		}

		if (paneType === "browser" && !optionalString(args, "url")) {
			throw new ControlError(
				"BAD_REQUEST",
				"--url is required for --type browser",
			);
		}
		if (paneType === "file-viewer" && !optionalString(args, "path")) {
			throw new ControlError(
				"BAD_REQUEST",
				"--path is required for --type file-viewer",
			);
		}

		const op: BridgeOp = {
			kind: "new-pane",
			paneType,
			sourcePaneId,
			tabId: tab.id,
			workspaceId: tab.workspaceId,
			direction,
			url: optionalString(args, "url"),
			path: optionalString(args, "path"),
			cwd: optionalString(args, "cwd"),
			command: optionalString(args, "command"),
			focus: optionalBoolean(args, "focus", true),
		};
		return session.host.dispatchToRenderer(op);
	},

	"new-split": async (session, args) => {
		const snapshot = session.host.getSnapshot();
		const sourcePaneId = resolveTarget(
			snapshot,
			"pane",
			optionalString(args, "pane") ?? "focused",
		);
		const tabId = requirePane(snapshot, sourcePaneId).tabId;
		return session.host.dispatchToRenderer({
			kind: "new-split",
			sourcePaneId,
			tabId,
			direction: requireEnum(args, "direction", DIRECTIONS, "right"),
			cwd: optionalString(args, "cwd"),
			focus: optionalBoolean(args, "focus", true),
		});
	},

	/** Pull a pane out of its tab into a new tab of its own. */
	"split-off": async (session, args) => {
		const snapshot = session.host.getSnapshot();
		const paneId = resolveTarget(
			snapshot,
			"pane",
			optionalString(args, "pane") ?? "focused",
		);
		return session.host.dispatchToRenderer({ kind: "split-off", paneId });
	},

	"focus-pane": async (session, args) => {
		const snapshot = session.host.getSnapshot();
		const paneId = resolveTarget(snapshot, "pane", requireString(args, "pane"));
		const tabId = requirePane(snapshot, paneId).tabId;
		const tab = snapshot.tabs.find((t) => t.id === tabId);
		if (!tab) {
			throw new ControlError("NOT_FOUND", `Pane ${paneId} has no tab`);
		}
		return session.host.dispatchToRenderer({
			kind: "focus-pane",
			paneId,
			tabId,
			workspaceId: tab.workspaceId,
		});
	},

	"move-pane": async (session, args) => {
		const snapshot = session.host.getSnapshot();
		const paneId = resolveTarget(snapshot, "pane", requireString(args, "pane"));
		const targetTabId = resolveTarget(
			snapshot,
			"tab",
			requireString(args, "to-tab"),
		);
		return session.host.dispatchToRenderer({
			kind: "move-pane",
			paneId,
			targetTabId,
		});
	},

	"close-pane": async (session, args) => {
		const snapshot = session.host.getSnapshot();
		const paneId = resolveTarget(
			snapshot,
			"pane",
			optionalString(args, "pane") ?? "focused",
		);
		return session.host.dispatchToRenderer({ kind: "close-pane", paneId });
	},
};
