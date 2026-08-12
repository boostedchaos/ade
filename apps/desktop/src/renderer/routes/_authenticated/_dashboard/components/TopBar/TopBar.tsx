import { useParams } from "@tanstack/react-router";
import { HiOutlineWifi } from "react-icons/hi2";
import { useOnlineStatus } from "renderer/hooks/useOnlineStatus";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { ArgusLockup } from "renderer/screens/main/components/Iris";
import { FleetStatusLine } from "./components/FleetStatusLine/FleetStatusLine";
import { NavigationControls } from "./components/NavigationControls";
import { OpenInMenuButton } from "./components/OpenInMenuButton";
import { OrganizationDropdown } from "./components/OrganizationDropdown";
import { ResourceConsumption } from "./components/ResourceConsumption";
import { SidebarToggle } from "./components/SidebarToggle";
import { WindowControls } from "./components/WindowControls";

export function TopBar() {
	const { data: platform } = electronTrpc.window.getPlatform.useQuery();
	const { workspaceId } = useParams({ strict: false });
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const isOnline = useOnlineStatus();
	// Default to Mac layout while loading to avoid overlap with traffic lights
	const isMac = platform === undefined || platform === "darwin";

	return (
		// Argus titlebar: 46px on mac, 40px on Windows, on the panel step with a
		// single hairline under it. No shadow — separation in this app is done
		// with hairlines and background steps only.
		<div
			className="drag gap-2 w-full flex items-center justify-between relative"
			style={{
				height: "var(--argus-titlebar-height)",
				backgroundColor: "var(--argus-panel)",
				borderBottom: "1px solid var(--argus-hairline)",
			}}
		>
			<div
				className="flex items-center gap-1.5 h-full"
				style={{
					paddingLeft: isMac ? "88px" : "16px",
				}}
			>
				<ArgusLockup markSize={16} wordmarkSize={14} className="no-drag" />
				<SidebarToggle />
				{/* hidden below md; display:contents at md+ so desktop layout is unchanged */}
				<div className="hidden md:contents">
					<NavigationControls />
					<ResourceConsumption />
				</div>
			</div>

			{workspace?.project?.name && (
				<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
					<div className="flex items-center gap-2 max-w-[50vw] md:max-w-[calc(100vw-36rem)] lg:max-w-[calc(100vw-52rem)]">
						{workspace.iconUrl && (
							<img
								src={workspace.iconUrl}
								alt=""
								className="size-5 shrink-0 rounded-full object-cover"
							/>
						)}
						<span className="text-sm text-muted-foreground font-medium truncate">
							{[workspace.project.name, workspace.name]
								.filter(Boolean)
								.join(" - ")}
						</span>
						{workspace.role && (
							<span className="text-sm text-muted-foreground/60 truncate">
								· {workspace.role}
							</span>
						)}
					</div>
				</div>
			)}

			<div className="flex items-center gap-3 h-full pr-4 shrink-0">
				{/*
				 * The palette keyboard hint (DESIGN-BRIEF §2a). A HINT, not a
				 * button: the command palette's open state is local to the
				 * workspace page, so making this clickable would mean lifting it
				 * into a store — a behavior change, and this build is a reskin.
				 */}
				<span
					className="hidden md:inline-flex items-center font-mono"
					style={{
						fontSize: "var(--argus-size-chip)",
						color: "var(--argus-text-label)",
						border: "1px solid var(--argus-hairline)",
						borderRadius: "var(--argus-radius-surface)",
						padding: "5px 12px",
					}}
				>
					{isMac ? "⌘K" : "Ctrl K"}
				</span>
				<FleetStatusLine className="hidden md:flex" />
				{!isOnline && (
					<div className="no-drag flex items-center gap-1.5 text-xs text-muted-foreground bg-muted px-2 py-1 rounded">
						<HiOutlineWifi className="size-3.5" />
						<span>Offline</span>
					</div>
				)}
				{workspace?.worktreePath && (
					<div className="hidden md:contents">
						<OpenInMenuButton
							worktreePath={workspace.worktreePath}
							branch={workspace.worktree?.branch}
							projectId={workspace.project?.id}
						/>
					</div>
				)}
				<OrganizationDropdown />
				{!isMac && <WindowControls />}
			</div>
		</div>
	);
}
