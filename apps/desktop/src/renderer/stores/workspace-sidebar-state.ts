import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

// Argus rail width (DESIGN-BRIEF.md "Spacing, radii, borders"): 238px on mac,
// 250px on Windows. This panel is user-resizable and the width is persisted,
// so this is only the starting point — a user who has already dragged it keeps
// their width, which is the correct behavior. The 12px platform difference is
// not worth branching a persisted store over.
const DEFAULT_WORKSPACE_SIDEBAR_WIDTH = 238;
export const COLLAPSED_WORKSPACE_SIDEBAR_WIDTH = 52;
const MIN_WORKSPACE_SIDEBAR_WIDTH = 220;
export const MAX_WORKSPACE_SIDEBAR_WIDTH = 400;

// Threshold for snapping to collapsed state
const COLLAPSE_THRESHOLD = 120;

interface WorkspaceSidebarState {
	isOpen: boolean;
	width: number;
	lastExpandedWidth: number;
	// Use string[] instead of Set<string> for JSON serialization with Zustand persist
	collapsedProjectIds: string[];
	isResizing: boolean;
	// Mobile: the rail renders as an overlay drawer (PHASE_3 §3). Ephemeral —
	// never persisted, so the drawer always starts closed.
	isMobileDrawerOpen: boolean;

	toggleOpen: () => void;
	setMobileDrawerOpen: (open: boolean) => void;
	toggleMobileDrawer: () => void;
	setOpen: (open: boolean) => void;
	setWidth: (width: number) => void;
	setIsResizing: (isResizing: boolean) => void;
	toggleProjectCollapsed: (projectId: string) => void;
	isProjectCollapsed: (projectId: string) => boolean;
	toggleCollapsed: () => void;
	isCollapsed: () => boolean;
}

export const useWorkspaceSidebarStore = create<WorkspaceSidebarState>()(
	devtools(
		persist(
			(set, get) => ({
				isOpen: true,
				width: DEFAULT_WORKSPACE_SIDEBAR_WIDTH,
				lastExpandedWidth: DEFAULT_WORKSPACE_SIDEBAR_WIDTH,
				collapsedProjectIds: [],
				isResizing: false,
				isMobileDrawerOpen: false,

				setMobileDrawerOpen: (open) => {
					set({ isMobileDrawerOpen: open });
				},

				toggleMobileDrawer: () => {
					set((state) => ({ isMobileDrawerOpen: !state.isMobileDrawerOpen }));
				},

				toggleOpen: () => {
					const { isOpen, lastExpandedWidth } = get();
					if (isOpen) {
						set({ isOpen: false, width: 0 });
					} else {
						set({
							isOpen: true,
							width: lastExpandedWidth,
						});
					}
				},

				setOpen: (open) => {
					const { lastExpandedWidth } = get();
					set({
						isOpen: open,
						width: open ? lastExpandedWidth : 0,
					});
				},

				setWidth: (width) => {
					// Snap to collapsed if below threshold (never allow closing completely via drag)
					if (width < COLLAPSE_THRESHOLD) {
						set({
							width: COLLAPSED_WORKSPACE_SIDEBAR_WIDTH,
							isOpen: true,
						});
						return;
					}

					// Clamp to expanded range
					const clampedWidth = Math.max(
						MIN_WORKSPACE_SIDEBAR_WIDTH,
						Math.min(MAX_WORKSPACE_SIDEBAR_WIDTH, width),
					);

					set({
						width: clampedWidth,
						lastExpandedWidth: clampedWidth,
						isOpen: true,
					});
				},

				setIsResizing: (isResizing) => {
					set({ isResizing });
				},

				toggleProjectCollapsed: (projectId) => {
					set((state) => ({
						collapsedProjectIds: state.collapsedProjectIds.includes(projectId)
							? state.collapsedProjectIds.filter((id) => id !== projectId)
							: [...state.collapsedProjectIds, projectId],
					}));
				},

				isProjectCollapsed: (projectId) => {
					return get().collapsedProjectIds.includes(projectId);
				},

				toggleCollapsed: () => {
					const { width, lastExpandedWidth } = get();
					const isCurrentlyCollapsed =
						width === COLLAPSED_WORKSPACE_SIDEBAR_WIDTH;

					if (isCurrentlyCollapsed) {
						set({ width: lastExpandedWidth });
					} else {
						set({ width: COLLAPSED_WORKSPACE_SIDEBAR_WIDTH });
					}
				},

				isCollapsed: () => {
					return get().width === COLLAPSED_WORKSPACE_SIDEBAR_WIDTH;
				},
			}),
			{
				name: "workspace-sidebar-store",
				version: 2,
				// Exclude ephemeral state from persistence
				partialize: (state) => ({
					isOpen: state.isOpen,
					width: state.width,
					lastExpandedWidth: state.lastExpandedWidth,
					collapsedProjectIds: state.collapsedProjectIds,
					// isResizing intentionally excluded - ephemeral UI state
				}),
			},
		),
		{ name: "WorkspaceSidebarStore" },
	),
);
