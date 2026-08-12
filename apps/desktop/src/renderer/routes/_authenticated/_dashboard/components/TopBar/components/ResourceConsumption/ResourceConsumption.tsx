import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
	HiOutlineArrowPath,
	HiOutlineChevronDown,
	HiOutlineChevronRight,
	HiOutlineCpuChip,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";

function formatMemory(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCpu(percent: number): string {
	return `${percent.toFixed(1)}%`;
}

/** "resets in 2h 15m" from an ISO timestamp, or null if past/unparseable. */
function formatReset(iso: string | null): string | null {
	if (!iso) return null;
	const ms = new Date(iso).getTime() - Date.now();
	if (Number.isNaN(ms) || ms <= 0) return null;
	const h = Math.floor(ms / 3_600_000);
	const m = Math.round((ms % 3_600_000) / 60_000);
	return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

const METRIC_COLS = "flex items-center shrink-0 tabular-nums";
const CPU_COL = "w-12 text-right";
const MEM_COL = "w-16 text-right";

export function ResourceConsumption() {
	const [open, setOpen] = useState(false);
	const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(
		new Set(),
	);
	const navigate = useNavigate();
	const panes = useTabsStore((s) => s.panes);
	const setActiveTab = useTabsStore((s) => s.setActiveTab);
	const setFocusedPane = useTabsStore((s) => s.setFocusedPane);

	const { data: enabled } =
		electronTrpc.settings.getShowResourceMonitor.useQuery();

	const {
		data: snapshot,
		refetch,
		isFetching,
	} = electronTrpc.resourceMetrics.getSnapshot.useQuery(undefined, {
		enabled: enabled === true,
		refetchInterval: open ? 2000 : false,
	});

	// Provider usage (issue #35). Server caches 60s; poll slowly even while
	// closed so the trigger's session % stays current.
	const { data: usage } = electronTrpc.usage.getSnapshot.useQuery(undefined, {
		enabled: enabled === true,
		refetchInterval: open ? 60_000 : 300_000,
	});

	if (!enabled) return null;

	const getPaneName = (paneId: string): string => {
		const pane = panes[paneId];
		return pane?.name || `Pane ${paneId.slice(0, 6)}`;
	};

	const navigateToWorkspace = (workspaceId: string) => {
		navigate({ to: `/workspace/${workspaceId}` });
		setOpen(false);
	};

	const navigateToPane = (workspaceId: string, paneId: string) => {
		const pane = panes[paneId];
		if (pane) {
			setActiveTab(workspaceId, pane.tabId);
			setFocusedPane(pane.tabId, paneId);
		}
		navigate({ to: `/workspace/${workspaceId}` });
		setOpen(false);
	};

	const toggleWorkspace = (workspaceId: string) => {
		setCollapsedWorkspaces((prev) => {
			const next = new Set(prev);
			if (next.has(workspaceId)) {
				next.delete(workspaceId);
			} else {
				next.add(workspaceId);
			}
			return next;
		});
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="no-drag flex items-center gap-1.5 h-6 px-1.5 rounded border border-border/60 bg-secondary/50 hover:bg-secondary hover:border-border transition-all duration-150 ease-out focus:outline-none focus:ring-1 focus:ring-ring"
					aria-label="Resource consumption"
				>
					<HiOutlineCpuChip className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
					{snapshot && (
						<span className="text-xs text-muted-foreground font-medium tabular-nums">
							{formatMemory(snapshot.totalMemory)}
						</span>
					)}
					{usage?.claude?.fiveHour && (
						<span className="text-xs text-muted-foreground font-medium tabular-nums">
							· {Math.round(usage.claude.fiveHour.utilization)}%
						</span>
					)}
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 p-0">
				<div className="p-3 border-b border-border">
					<div className="flex items-center justify-between">
						<h4 className="argus-label">Resource Usage</h4>
						<button
							type="button"
							onClick={() => refetch()}
							className="p-0.5 rounded hover:bg-muted transition-colors"
							aria-label="Refresh metrics"
						>
							<HiOutlineArrowPath
								className={`h-3.5 w-3.5 text-muted-foreground ${isFetching ? "animate-spin" : ""}`}
							/>
						</button>
					</div>
					{snapshot && (
						<div className="mt-2 flex items-center gap-4">
							<MetricBadge label="CPU" value={formatCpu(snapshot.totalCpu)} />
							<MetricBadge
								label="Memory"
								value={formatMemory(snapshot.totalMemory)}
							/>
						</div>
					)}
				</div>

				{usage && (usage.claude || usage.openrouter) && (
					<div className="p-3 border-b border-border">
						<h4 className="argus-label">Provider Usage</h4>
						<div className="mt-2 space-y-1.5">
							{usage.claude?.fiveHour && (
								<UsageRow
									label="Claude · session (5h)"
									value={`${Math.round(usage.claude.fiveHour.utilization)}%`}
									hint={formatReset(usage.claude.fiveHour.resetsAt)}
								/>
							)}
							{usage.claude?.sevenDay && (
								<UsageRow
									label="Claude · week"
									value={`${Math.round(usage.claude.sevenDay.utilization)}%`}
									hint={formatReset(usage.claude.sevenDay.resetsAt)}
								/>
							)}
							{usage.openrouter && (
								<UsageRow
									label="OpenRouter credits"
									value={`$${usage.openrouter.totalUsage.toFixed(2)} / $${usage.openrouter.totalCredits.toFixed(2)}`}
								/>
							)}
						</div>
					</div>
				)}

				<div className="max-h-[50vh] overflow-y-auto">
					{snapshot && (
						<div className="border-b border-border/50">
							<div className="px-3 py-2 flex items-center justify-between">
								<span className="text-xs font-medium min-w-0 truncate">
									Argus App
								</span>
								<div className={`${METRIC_COLS} text-xs text-muted-foreground`}>
									<span className={CPU_COL}>{formatCpu(snapshot.app.cpu)}</span>
									<span className={MEM_COL}>
										{formatMemory(snapshot.app.memory)}
									</span>
								</div>
							</div>
							<div className="px-3 py-1.5 pl-6 flex items-center justify-between bg-muted/30">
								<span className="text-[11px] text-muted-foreground min-w-0 truncate">
									Main
								</span>
								<div
									className={`${METRIC_COLS} text-[11px] text-muted-foreground`}
								>
									<span className={CPU_COL}>
										{formatCpu(snapshot.app.main.cpu)}
									</span>
									<span className={MEM_COL}>
										{formatMemory(snapshot.app.main.memory)}
									</span>
								</div>
							</div>
							<div className="px-3 py-1.5 pl-6 flex items-center justify-between bg-muted/30">
								<span className="text-[11px] text-muted-foreground min-w-0 truncate">
									Renderer
								</span>
								<div
									className={`${METRIC_COLS} text-[11px] text-muted-foreground`}
								>
									<span className={CPU_COL}>
										{formatCpu(snapshot.app.renderer.cpu)}
									</span>
									<span className={MEM_COL}>
										{formatMemory(snapshot.app.renderer.memory)}
									</span>
								</div>
							</div>
						</div>
					)}

					{snapshot?.workspaces.map((ws) => {
						const isCollapsed = collapsedWorkspaces.has(ws.workspaceId);
						return (
							<div
								key={ws.workspaceId}
								className="border-b border-border/50 last:border-b-0"
							>
								<div className="flex items-center">
									{ws.sessions.length > 0 && (
										<button
											type="button"
											onClick={() => toggleWorkspace(ws.workspaceId)}
											className="pl-2 py-2 pr-0.5 hover:bg-muted/50 transition-colors"
											aria-label={
												isCollapsed ? "Expand agent" : "Collapse agent"
											}
										>
											{isCollapsed ? (
												<HiOutlineChevronRight className="h-3 w-3 text-muted-foreground" />
											) : (
												<HiOutlineChevronDown className="h-3 w-3 text-muted-foreground" />
											)}
										</button>
									)}
									<button
										type="button"
										onClick={() => navigateToWorkspace(ws.workspaceId)}
										className={`flex-1 min-w-0 py-2 pr-3 flex items-center justify-between hover:bg-muted/50 transition-colors ${ws.sessions.length > 0 ? "pl-1" : "pl-3"}`}
									>
										<span className="text-xs font-medium truncate min-w-0 mr-2">
											{ws.workspaceName}
										</span>
										<div
											className={`${METRIC_COLS} text-xs text-muted-foreground`}
										>
											<span className={CPU_COL}>{formatCpu(ws.cpu)}</span>
											<span className={MEM_COL}>{formatMemory(ws.memory)}</span>
										</div>
									</button>
								</div>

								{!isCollapsed &&
									ws.sessions.map((session) => (
										<button
											type="button"
											key={session.sessionId}
											onClick={() =>
												navigateToPane(ws.workspaceId, session.paneId)
											}
											className="w-full px-3 py-1.5 pl-6 flex items-center justify-between bg-muted/30 hover:bg-muted/60 transition-colors"
										>
											<span className="text-[11px] text-muted-foreground truncate min-w-0 mr-2">
												{getPaneName(session.paneId)}
											</span>
											<div
												className={`${METRIC_COLS} text-[11px] text-muted-foreground`}
											>
												<span className={CPU_COL}>
													{formatCpu(session.cpu)}
												</span>
												<span className={MEM_COL}>
													{formatMemory(session.memory)}
												</span>
											</div>
										</button>
									))}
							</div>
						);
					})}

					{snapshot && snapshot.workspaces.length === 0 && (
						<div className="px-3 py-4 text-center text-xs text-muted-foreground">
							No active terminal sessions
						</div>
					)}

					{!snapshot && (
						<div className="px-3 py-4 text-center text-xs text-muted-foreground">
							Loading...
						</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function UsageRow({
	label,
	value,
	hint,
}: {
	label: string;
	value: string;
	hint?: string | null;
}) {
	return (
		<div className="flex items-center justify-between">
			<span className="text-xs text-muted-foreground min-w-0 truncate">
				{label}
			</span>
			<div className="flex items-center gap-2 shrink-0">
				{hint && (
					<span className="text-[10px] text-muted-foreground/70">{hint}</span>
				)}
				<span className="text-xs font-medium tabular-nums">{value}</span>
			</div>
		</div>
	);
}

function MetricBadge({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center gap-1.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="text-sm font-medium tabular-nums">{value}</span>
		</div>
	);
}
