import { useEffect } from "react";
import { useIsMobile } from "renderer/hooks/useIsMobile";
import {
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	SidebarMode,
	useSidebarStore,
} from "renderer/stores/sidebar-state";
import { ResizablePanel } from "../../ResizablePanel";
import { ChangesContent, ScrollProvider } from "../ChangesContent";
import { ContentView } from "../ContentView";
import { useBrowserLifecycle } from "../hooks/useBrowserLifecycle";
import { RightSidebar } from "../RightSidebar";

export function WorkspaceLayout() {
	useBrowserLifecycle();
	const {
		isSidebarOpen,
		sidebarWidth,
		setSidebarWidth,
		isResizing,
		setIsResizing,
		currentMode,
		setSidebarOpen,
	} = useSidebarStore();

	const isExpanded = currentMode === SidebarMode.Changes;

	// Phone (PHASE_3 §3): the files sidebar renders as a bottom sheet, and it
	// starts closed — the persisted desktop default (open) would cover the
	// terminal on first visit.
	const isMobile = useIsMobile();
	useEffect(() => {
		if (isMobile) setSidebarOpen(false);
	}, [isMobile, setSidebarOpen]);

	return (
		<ScrollProvider>
			<div className="flex-1 min-w-0 overflow-hidden">
				{isExpanded ? <ChangesContent /> : <ContentView />}
			</div>
			{isSidebarOpen &&
				(isMobile ? (
					<div className="fixed inset-0 z-50">
						<div
							className="absolute inset-0 bg-black/50"
							onClick={() => setSidebarOpen(false)}
							aria-hidden="true"
						/>
						<div
							className="absolute inset-x-0 bottom-0 top-[15%] flex flex-col overflow-hidden rounded-t-xl border-t border-border bg-background shadow-xl"
							style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
							role="dialog"
							aria-label="Files"
						>
							<RightSidebar />
						</div>
					</div>
				) : (
					<ResizablePanel
						width={sidebarWidth}
						onWidthChange={setSidebarWidth}
						isResizing={isResizing}
						onResizingChange={setIsResizing}
						minWidth={MIN_SIDEBAR_WIDTH}
						maxWidth={MAX_SIDEBAR_WIDTH}
						handleSide="left"
						className={isExpanded ? "border-l-0" : undefined}
					>
						<RightSidebar />
					</ResizablePanel>
				))}
		</ScrollProvider>
	);
}
