import { useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useWorkspaceSidebarStore } from "renderer/stores/workspace-sidebar-state";

/**
 * Mobile replacement for the inline workspace rail (PHASE_3 §3): the same
 * WorkspaceSidebar content, presented as a left overlay drawer with a
 * backdrop. Closes on backdrop tap and on navigation (tapping an agent).
 */
export function MobileSidebarDrawer({
	children,
}: {
	children: React.ReactNode;
}) {
	const isOpen = useWorkspaceSidebarStore((s) => s.isMobileDrawerOpen);
	const setOpen = useWorkspaceSidebarStore((s) => s.setMobileDrawerOpen);

	// Close when the route changes — the drawer's purpose (navigation) is done.
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const previousPathname = useRef(pathname);
	useEffect(() => {
		if (previousPathname.current !== pathname) {
			previousPathname.current = pathname;
			setOpen(false);
		}
	}, [pathname, setOpen]);

	if (!isOpen) return null;

	return (
		<div className="fixed inset-0 z-50">
			<div
				className="absolute inset-0 bg-black/50"
				onClick={() => setOpen(false)}
				aria-hidden="true"
			/>
			<div
				className="absolute inset-y-0 left-0 flex w-[300px] max-w-[85vw] flex-col overflow-hidden border-r border-border bg-background shadow-xl"
				style={{
					paddingTop: "env(safe-area-inset-top)",
					paddingBottom: "env(safe-area-inset-bottom)",
					paddingLeft: "env(safe-area-inset-left)",
				}}
				role="dialog"
				aria-label="Teams and agents"
			>
				{children}
			</div>
		</div>
	);
}
