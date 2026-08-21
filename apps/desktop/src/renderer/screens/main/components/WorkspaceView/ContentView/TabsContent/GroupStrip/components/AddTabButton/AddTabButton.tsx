import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { BsTerminalPlus } from "react-icons/bs";
import { HiMiniChevronDown } from "react-icons/hi2";
import { LuFileText, LuMessagesSquare, LuPlus } from "react-icons/lu";
import { TbWorld } from "react-icons/tb";
import { HotkeyMenuShortcut } from "renderer/components/HotkeyMenuShortcut";
import { NewTabDropZone } from "../../NewTabDropZone";

interface AddTabButtonProps {
	useCompactAddButton: boolean;
	onDropToNewTab: (paneId: string) => void;
	isLastPaneInTab: (paneId: string) => boolean;
	/**
	 * The default agent session. Since Phase 6 (B3) this opens an ACP
	 * conversation for a Claude Code agent with a worktree, and a terminal for
	 * everything else — the branch lives in `spawnAgentSession`, not here.
	 */
	onAddTerminal: () => void;
	/**
	 * Optional: the same agent session, forced onto the TERMINAL path. The
	 * per-launch opt-out from the flip above, next to the global setting.
	 */
	onAddAgentTerminal?: () => void;
	/** Optional: open a plain shell tab, independent of the agent runtime. */
	onAddShell?: () => void;
	onAddBrowser: () => void;
	onAddNote: () => void;
	/**
	 * Optional: an ACP (agent conversation) session. Optional because the
	 * workspace must have a worktree path to root the session in — the button
	 * is absent rather than present-and-broken when it does not.
	 */
	onAddAcp?: () => void;
	onToggleCompactAddButton: (enabled: boolean) => void;
}

export function AddTabButton({
	useCompactAddButton,
	onDropToNewTab,
	isLastPaneInTab,
	onAddTerminal,
	onAddAgentTerminal,
	onAddShell,
	onAddBrowser,
	onAddNote,
	onAddAcp,
	onToggleCompactAddButton,
}: AddTabButtonProps) {
	const showBigAddButton = !useCompactAddButton;

	return (
		<NewTabDropZone onDrop={onDropToNewTab} isLastPaneInTab={isLastPaneInTab}>
			<DropdownMenu>
				<div className="flex items-center shrink-0">
					{showBigAddButton ? (
						<>
							<Button
								variant="outline"
								className="h-7 rounded-r-none pl-2 pr-1.5 gap-1 text-xs"
								onClick={onAddTerminal}
							>
								<BsTerminalPlus className="size-3.5" />
								Session
							</Button>
							<Button
								variant="outline"
								className="h-7 rounded-none border-l-0 px-1.5 gap-1 text-xs"
								onClick={onAddBrowser}
							>
								<TbWorld className="size-3.5" />
								Browser
							</Button>
							<Button
								variant="outline"
								className="h-7 rounded-none border-l-0 px-1.5 gap-1 text-xs"
								onClick={onAddNote}
							>
								<LuFileText className="size-3.5" />
								Note
							</Button>
							<DropdownMenuTrigger asChild>
								<Button
									variant="outline"
									size="icon"
									className="size-7 rounded-l-none border-l-0 px-1"
								>
									<HiMiniChevronDown className="size-3" />
								</Button>
							</DropdownMenuTrigger>
						</>
					) : (
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="size-7 px-1 rounded-md border border-border/60 bg-muted/30 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
							>
								<LuPlus className="size-3.5" strokeWidth={1.8} />
							</Button>
						</DropdownMenuTrigger>
					)}
				</div>
				<DropdownMenuContent align="end" className="w-56">
					{onAddAcp && (
						<DropdownMenuItem onClick={onAddAcp} className="gap-2">
							<LuMessagesSquare className="size-4" />
							<span>ACP Session</span>
						</DropdownMenuItem>
					)}
					{onAddAgentTerminal && (
						<DropdownMenuItem onClick={onAddAgentTerminal} className="gap-2">
							<BsTerminalPlus className="size-4" />
							<span>Agent session (terminal)</span>
						</DropdownMenuItem>
					)}
					{(onAddAcp || onAddAgentTerminal) && <DropdownMenuSeparator />}
					{onAddShell && (
						<>
							<DropdownMenuItem onClick={onAddShell} className="gap-2">
								<BsTerminalPlus className="size-4" />
								<span>Plain Shell</span>
							</DropdownMenuItem>
							<DropdownMenuSeparator />
						</>
					)}
					{!showBigAddButton && (
						<>
							<DropdownMenuItem onClick={onAddTerminal} className="gap-2">
								<BsTerminalPlus className="size-4" />
								<span>Session</span>
								<HotkeyMenuShortcut hotkeyId="NEW_GROUP" />
							</DropdownMenuItem>
							<DropdownMenuItem onClick={onAddBrowser} className="gap-2">
								<TbWorld className="size-4" />
								<span>Browser</span>
								<HotkeyMenuShortcut hotkeyId="NEW_BROWSER" />
							</DropdownMenuItem>
							<DropdownMenuItem onClick={onAddNote} className="gap-2">
								<LuFileText className="size-4" />
								<span>Note</span>
							</DropdownMenuItem>
							<DropdownMenuSeparator />
						</>
					)}
					<DropdownMenuCheckboxItem
						checked={useCompactAddButton}
						onCheckedChange={(checked) =>
							onToggleCompactAddButton(checked === true)
						}
						onSelect={(e) => e.preventDefault()}
					>
						Use Compact Button
					</DropdownMenuCheckboxItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</NewTabDropZone>
	);
}
