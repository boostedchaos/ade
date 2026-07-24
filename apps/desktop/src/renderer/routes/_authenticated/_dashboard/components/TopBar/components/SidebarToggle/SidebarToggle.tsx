import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { LuPanelLeft, LuPanelLeftClose, LuPanelLeftOpen } from "react-icons/lu";
import { HotkeyTooltipContent } from "renderer/components/HotkeyTooltipContent";
import { useIsMobile } from "renderer/hooks/useIsMobile";
import { useWorkspaceSidebarStore } from "renderer/stores";

export function SidebarToggle() {
	const { isCollapsed, toggleCollapsed, toggleMobileDrawer } =
		useWorkspaceSidebarStore();
	// On phones the rail is an overlay drawer; the same button opens it.
	const isMobile = useIsMobile();
	const collapsed = isCollapsed();

	const getToggleIcon = (isHovering: boolean) => {
		if (collapsed) {
			return isHovering ? (
				<LuPanelLeftOpen className="size-4" strokeWidth={1.5} />
			) : (
				<LuPanelLeft className="size-4" strokeWidth={1.5} />
			);
		}
		return isHovering ? (
			<LuPanelLeftClose className="size-4" strokeWidth={1.5} />
		) : (
			<LuPanelLeft className="size-4" strokeWidth={1.5} />
		);
	};

	return (
		<Tooltip delayDuration={300}>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={isMobile ? toggleMobileDrawer : toggleCollapsed}
					aria-label="Toggle sidebar"
					className="no-drag group flex items-center justify-center size-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
				>
					<span className="group-hover:hidden">{getToggleIcon(false)}</span>
					<span className="hidden group-hover:block">
						{getToggleIcon(true)}
					</span>
				</button>
			</TooltipTrigger>
			<TooltipContent side="right">
				<HotkeyTooltipContent
					label="Toggle sidebar"
					hotkeyId="TOGGLE_WORKSPACE_SIDEBAR"
				/>
			</TooltipContent>
		</Tooltip>
	);
}
