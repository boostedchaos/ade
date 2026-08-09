import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { LuBell } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { navigateToWorkspace } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import { AttentionBadge } from "renderer/screens/main/components/AttentionBadge";
import {
	type AttentionNotification,
	useAttention,
} from "renderer/stores/attention/useAttention";
import { useTabsStore } from "renderer/stores/tabs/store";

/**
 * The attention inbox (Mission Control Feature 3), as a popover off the
 * workspace rail.
 *
 * A popover rather than a pane type, per the spec: notifications are a place
 * you glance at and leave, and making one a mosaic tile would put it in the
 * layout persistence, the split actions and the drag-and-drop surface for no
 * benefit.
 */

function relativeTime(timestamp: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

interface NotificationPanelProps {
	isCollapsed?: boolean;
}

export function NotificationPanel({ isCollapsed }: NotificationPanelProps) {
	const [open, setOpen] = useState(false);
	const navigate = useNavigate();
	const { notifications, unread } = useAttention();
	const markRead = electronTrpc.attention.markRead.useMutation();
	const markAllRead = electronTrpc.attention.markAllRead.useMutation();

	// The list invalidation that follows a write arrives over the `changed`
	// subscription (useAttentionSync), so nothing here needs to refetch by hand.

	const handleSelect = (notification: AttentionNotification) => {
		if (notification.readAt === null) {
			markRead.mutate({ id: notification.id });
		}

		const { paneId, workspaceId } = notification;
		if (!paneId) {
			if (workspaceId) void navigateToWorkspace(workspaceId, navigate);
			setOpen(false);
			return;
		}

		const state = useTabsStore.getState();
		const pane = state.panes[paneId];
		if (!pane) {
			// The pane is gone — a finished agent's terminal, usually. Marking read
			// above is still right; there is just nowhere to go.
			setOpen(false);
			return;
		}
		const tab = state.tabs.find((t) => t.id === pane.tabId);
		const targetWorkspaceId = tab?.workspaceId ?? workspaceId;
		if (tab && targetWorkspaceId) {
			state.setActiveTab(targetWorkspaceId, tab.id);
			state.setFocusedPane(tab.id, paneId);
		}
		if (targetWorkspaceId) {
			void navigateToWorkspace(targetWorkspaceId, navigate, {
				search: { tabId: tab?.id, paneId },
			});
		}
		setOpen(false);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label={
								unread > 0
									? `Notifications (${unread} unread)`
									: "Notifications"
							}
							className={cn(
								"relative flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground",
								isCollapsed ? "size-8" : "size-6",
							)}
						>
							<LuBell className="size-4" />
							{unread > 0 && (
								<AttentionBadge
									count={unread}
									size="sm"
									className="-top-0.5 -right-0.5 absolute"
								/>
							)}
						</button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent side="right">Notifications</TooltipContent>
			</Tooltip>

			<PopoverContent align="start" side="right" className="w-80 p-0">
				<div className="flex items-center justify-between border-b px-3 py-2">
					<span className="font-medium text-sm">Notifications</span>
					{unread > 0 && (
						<button
							type="button"
							onClick={() => markAllRead.mutate()}
							className="text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
						>
							Mark all read
						</button>
					)}
				</div>

				{notifications.length === 0 ? (
					<p className="px-3 py-6 text-center text-muted-foreground text-sm">
						Nothing needs you right now.
					</p>
				) : (
					<ul className="max-h-96 overflow-y-auto">
						{notifications.map((notification) => {
							const isUnread = notification.readAt === null;
							return (
								<li key={notification.id}>
									<button
										type="button"
										onClick={() => handleSelect(notification)}
										className={cn(
											"flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted",
											isUnread && "bg-muted/40",
										)}
									>
										<span className="flex w-full items-center gap-2">
											{isUnread && (
												<span
													aria-hidden
													className="size-1.5 shrink-0 rounded-full bg-destructive"
												/>
											)}
											<span
												className={cn(
													"min-w-0 flex-1 truncate text-sm",
													isUnread
														? "font-medium text-foreground"
														: "text-muted-foreground",
												)}
											>
												{notification.title}
											</span>
											<span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
												{relativeTime(notification.createdAt)}
											</span>
										</span>
										{notification.body && (
											<span className="line-clamp-2 pl-3.5 text-muted-foreground text-xs">
												{notification.body}
											</span>
										)}
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</PopoverContent>
		</Popover>
	);
}
