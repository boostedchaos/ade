import { useSidebarStore } from "renderer/stores/sidebar-state";
import { SidebarControl } from "../../SidebarControl";
import { BlockedSessionStrip } from "./BlockedSessionStrip/BlockedSessionStrip";
import { ContentHeader } from "./ContentHeader";
import { ModelBar } from "./ModelBar";
import { TabsContent } from "./TabsContent";
import { GroupStrip } from "./TabsContent/GroupStrip";

export function ContentView() {
	const isSidebarOpen = useSidebarStore((s) => s.isSidebarOpen);

	return (
		<div className="h-full flex flex-col overflow-hidden">
			<ContentHeader
				trailingAction={!isSidebarOpen ? <SidebarControl /> : undefined}
			>
				<GroupStrip />
			</ContentHeader>
			<ModelBar />
			<TabsContent />
			{/* Above the status bar, below the terminal — and it renders nothing
			    at all unless another agent is actually waiting. */}
			<BlockedSessionStrip />
		</div>
	);
}
