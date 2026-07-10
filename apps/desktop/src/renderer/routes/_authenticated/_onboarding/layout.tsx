import { createFileRoute, Outlet } from "@tanstack/react-router";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { WindowControls } from "renderer/routes/_authenticated/_dashboard/components/TopBar/components/WindowControls";

export const Route = createFileRoute("/_authenticated/_onboarding")({
	component: OnboardingLayout,
});

function OnboardingLayout() {
	const { data: platform } = electronTrpc.window.getPlatform.useQuery();
	const isMac = platform === undefined || platform === "darwin";

	return (
		<div className="flex flex-col h-full w-full bg-background">
			{/* Drag region for window dragging (macOS traffic lights / Windows title bar).
			    Hosts the custom window controls on Windows/Linux (frameless window). */}
			<div
				className="drag h-12 w-full shrink-0 flex items-center justify-end"
				style={{
					paddingLeft: isMac ? "88px" : "16px",
				}}
			>
				{!isMac && <WindowControls />}
			</div>
			<Outlet />
		</div>
	);
}
