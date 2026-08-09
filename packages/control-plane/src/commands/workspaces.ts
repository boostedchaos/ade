import { optionalBoolean, optionalString, requireString } from "../args";
import { ControlError } from "../protocol";
import type { CommandRegistry } from "../server";
import { panesForTabInOrder, tabsForWorkspace } from "../snapshot";
import { resolveTarget } from "../target-resolution";

/**
 * Tabs / workspaces group. Same split as panes: every list command is a main
 * process read; `new-tab` and `focus-workspace` are renderer mutations;
 * `new-workspace` is a main-process DB + git operation and never touches the
 * renderer.
 */
export const workspaceCommands: CommandRegistry = {
	"list-tabs": (session, args) => {
		const snapshot = session.host.getSnapshot();
		const workspaceId = resolveTarget(
			snapshot,
			"workspace",
			optionalString(args, "workspace") ?? "focused",
		);
		const activeTabId = snapshot.activeTabIds[workspaceId] ?? null;

		return {
			workspaceId,
			tabs: tabsForWorkspace(snapshot, workspaceId).map((tab, index) => ({
				index: index + 1,
				id: tab.id,
				name: tab.userTitle ?? tab.name,
				createdAt: tab.createdAt,
				active: tab.id === activeTabId,
				paneCount: panesForTabInOrder(snapshot, tab.id).length,
			})),
		};
	},

	"new-tab": async (session, args) => {
		const snapshot = session.host.getSnapshot();
		const workspaceId = resolveTarget(
			snapshot,
			"workspace",
			optionalString(args, "workspace") ?? "focused",
		);
		return session.host.dispatchToRenderer({
			kind: "new-tab",
			workspaceId,
			cwd: optionalString(args, "cwd"),
			command: optionalString(args, "command"),
			focus: optionalBoolean(args, "focus", true),
		});
	},

	"list-workspaces": (session) => {
		const snapshot = session.host.getSnapshot();
		const rows = new Map(session.host.listWorkspaces().map((w) => [w.id, w]));

		// Ordered by the rail's visual order so `workspace:<n>` in a later
		// command means the same n the user just read off this list.
		return {
			focusedWorkspaceId: snapshot.focusedWorkspaceId,
			workspaces: snapshot.workspaceOrder.map((id, index) => {
				const row = rows.get(id);
				return {
					index: index + 1,
					id,
					name: row?.name ?? null,
					type: row?.type ?? null,
					path: row?.path ?? null,
					branch: row?.branch ?? null,
					projectId: row?.projectId ?? null,
					focused: id === snapshot.focusedWorkspaceId,
					tabCount: tabsForWorkspace(snapshot, id).length,
				};
			}),
		};
	},

	"new-workspace": async (session, args) => {
		const project = requireString(args, "project");
		// `--worktree` is accepted and must be true: `workspaces.create` builds a
		// git-worktree workspace, and the other kind ("branch", the main
		// checkout) is created when a project is added and is constrained to one
		// per project by a unique index. Saying so beats silently ignoring it.
		if (!optionalBoolean(args, "worktree", true)) {
			throw new ControlError(
				"UNSUPPORTED",
				"Only worktree workspaces can be created from the CLI; a branch workspace is created with its project",
			);
		}
		const projectId = session.host.resolveProjectId(project);
		if (!projectId) {
			throw new ControlError("NOT_FOUND", `No project matching "${project}"`);
		}
		return session.host.dispatchToRenderer({
			kind: "create-workspace",
			projectId,
			name: optionalString(args, "name"),
		});
	},

	"focus-workspace": async (session, args) => {
		const snapshot = session.host.getSnapshot();
		const workspaceId = resolveTarget(
			snapshot,
			"workspace",
			requireString(args, "workspace"),
		);
		return session.host.dispatchToRenderer({
			kind: "focus-workspace",
			workspaceId,
		});
	},
};
