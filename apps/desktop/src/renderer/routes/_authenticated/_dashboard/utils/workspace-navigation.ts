import type {
	NavigateOptions,
	UseNavigateResult,
} from "@tanstack/react-router";
import { useWorkspaceSidebarStore } from "renderer/stores/workspace-sidebar-state";

export interface WorkspaceSearchParams {
	tabId?: string;
	paneId?: string;
}

/**
 * Navigate to a workspace and update localStorage to remember it as the last viewed workspace.
 * This ensures the workspace will be restored when the app is reopened.
 *
 * @param workspaceId - The ID of the workspace to navigate to
 * @param navigate - The navigate function from useNavigate()
 * @param options - Optional navigation options (replace, resetScroll, etc.)
 */
export function navigateToWorkspace(
	workspaceId: string,
	navigate: UseNavigateResult<string>,
	options?: Omit<NavigateOptions, "to" | "params"> & {
		search?: WorkspaceSearchParams;
	},
): Promise<void> {
	const { search, ...rest } = options ?? {};
	localStorage.setItem("lastViewedWorkspaceId", workspaceId);
	// Mobile drawer: selecting an agent is the end of the navigation gesture,
	// even when it's the already-active one (no route change to observe).
	useWorkspaceSidebarStore.getState().setMobileDrawerOpen(false);
	return navigate({
		to: "/workspace/$workspaceId",
		params: { workspaceId },
		search: search ?? {},
		...rest,
	});
}
