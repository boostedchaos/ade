import { useNavigate, useParams } from "@tanstack/react-router";
import { useBlockedAgents } from "renderer/hooks/useBlockedAgent";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { relativeTime } from "renderer/lib/relative-time";
import { navigateToWorkspace } from "renderer/routes/_authenticated/_dashboard/utils/workspace-navigation";
import { Iris } from "renderer/screens/main/components/Iris";
import { useTabsStore } from "renderer/stores";

/**
 * The blocked-session strip (DESIGN-BRIEF.md §2a, "additive").
 *
 * A full-width bar above the status bar reading
 * `rook is blocked on migrations — asked 4m ago`, with `jump to it` at the
 * right. Clicking switches to that session.
 *
 * Shown ONLY when a DIFFERENT agent is waiting — in this app's model an agent
 * is a workspace, so "different" means a blocked pane in another workspace.
 * That restriction is the point of the component: when the agent you are
 * already looking at is blocked you can see it for yourself, and
 * `WaitingOnYouBar` already covers that case inside the terminal. This bar
 * exists for the agent you are NOT looking at, which is the failure mode the
 * design is aimed at — an agent quietly waiting on another rail row.
 *
 * Every value it renders is a signal the app already tracks: pane status, the
 * attention inbox's `createdAt` and `body`, and the tabs store's names.
 */
export function BlockedSessionStrip() {
	const { workspaceId } = useParams({ strict: false });
	const navigate = useNavigate();
	const blocked = useBlockedAgents();
	const panes = useTabsStore((s) => s.panes);
	const tabs = useTabsStore((s) => s.tabs);
	const setActiveTab = useTabsStore((s) => s.setActiveTab);
	const setFocusedPane = useTabsStore((s) => s.setFocusedPane);

	// Blocked panes belonging to some OTHER workspace, oldest first so the bar
	// names the agent that has been waiting longest. Panes with no known ask
	// time sort last rather than first — an unknown age is not evidence of
	// having waited the longest.
	const elsewhere = Object.values(blocked)
		.map((b) => {
			const pane = panes[b.paneId];
			const tab = pane ? tabs.find((t) => t.id === pane.tabId) : undefined;
			return { blockedAgent: b, tab };
		})
		.filter(({ tab }) => tab && tab.workspaceId !== workspaceId)
		.sort(
			(a, b) =>
				(a.blockedAgent.askedAt ?? Number.POSITIVE_INFINITY) -
				(b.blockedAgent.askedAt ?? Number.POSITIVE_INFINITY),
		);

	const target = elsewhere[0];
	const targetWorkspaceId = target?.tab?.workspaceId;

	const { data: targetWorkspace } = electronTrpc.workspaces.get.useQuery(
		{ id: targetWorkspaceId ?? "" },
		{ enabled: !!targetWorkspaceId },
	);

	if (!target?.tab || !targetWorkspaceId) return null;

	const { blockedAgent, tab } = target;
	const agentName = targetWorkspace?.name ?? "An agent";

	const handleJump = () => {
		setActiveTab(targetWorkspaceId, tab.id);
		setFocusedPane(tab.id, blockedAgent.paneId);
		navigateToWorkspace(targetWorkspaceId, navigate);
	};

	const isMac = !document.documentElement.classList.contains("platform-win32");

	return (
		<button
			type="button"
			onClick={handleJump}
			className="flex w-full shrink-0 items-center gap-3 text-left transition-colors"
			style={{
				padding: "12px 22px",
				backgroundColor: "var(--argus-wash-amber)",
				borderTop: "1px solid var(--argus-hairline)",
				color: "var(--argus-text-amber)",
				fontSize: "var(--argus-size-body-tight)",
			}}
		>
			<Iris state="waiting" size={14} decorative />
			<span className="min-w-0 truncate">
				{agentName} is blocked on{" "}
				<span className="font-mono">{blockedAgent.sessionName}</span>
				{blockedAgent.askedAt !== null && (
					<> — asked {relativeTime(blockedAgent.askedAt)}</>
				)}
			</span>
			{blockedAgent.reason && (
				<span
					className="min-w-0 truncate font-mono"
					style={{
						color: "var(--argus-amber-muted)",
						fontSize: "var(--argus-size-chip)",
					}}
				>
					{blockedAgent.reason}
				</span>
			)}
			<span
				className="ml-auto shrink-0 font-mono"
				style={{ color: "var(--argus-iris-waiting)" }}
			>
				jump to it {isMac ? "⌥↵" : "· Alt+Enter"}
			</span>
		</button>
	);
}
