import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { Spinner } from "@superset/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useState } from "react";
import {
	LuCheck,
	LuChevronDown,
	LuGitMerge,
	LuGitPullRequest,
	LuRotateCcw,
	LuTriangleAlert,
	LuX,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { usePRStatus } from "renderer/screens/main/hooks";

type MergeStrategy = "squash" | "merge" | "rebase";

const STRATEGY_LABELS: Record<MergeStrategy, { action: string; menu: string }> =
	{
		squash: { action: "Squash and merge", menu: "Squash" },
		merge: { action: "Merge commit", menu: "Merge commit" },
		rebase: { action: "Rebase and merge", menu: "Rebase" },
	};

const CONFLICT_PREVIEW_COUNT = 5;

interface LandingActionsProps {
	worktreePath: string;
}

/**
 * Action bar for landing an agent's work without leaving the app: create a PR,
 * merge an open PR (with a strategy picker), or rebase the branch onto the
 * default branch. Rebase conflicts surface as an inline banner with the file
 * list, not a raw error string.
 *
 * ponytail: self-contained — reads workspaceId from the router and does its own
 * queries/mutations, so it can be dropped in below the diff toolbar with a
 * single prop and no wiring in the parent.
 */
export function LandingActions({ worktreePath }: LandingActionsProps) {
	const { workspaceId } = useParams({ strict: false });
	const utils = electronTrpc.useUtils();

	const { pr } = usePRStatus({ workspaceId });
	const { data: worktreeInfo } =
		electronTrpc.workspaces.getWorktreeInfo.useQuery(
			{ workspaceId: workspaceId ?? "" },
			{ enabled: !!workspaceId },
		);
	const { data: branchData } = electronTrpc.changes.getBranches.useQuery(
		{ worktreePath },
		{ enabled: !!worktreePath },
	);
	const { data: ghStatus } = electronTrpc.changes.ghAvailable.useQuery(
		undefined,
		{ staleTime: 60_000 },
	);

	const [strategy, setStrategy] = useState<MergeStrategy>("squash");
	const [conflict, setConflict] = useState<{
		files: string[];
		branch: string;
	} | null>(null);
	const [showAllConflicts, setShowAllConflicts] = useState(false);

	const defaultBranch = branchData?.defaultBranch ?? "the default branch";
	const needsRebase = worktreeInfo?.gitStatus?.needsRebase ?? false;
	const behindCount = worktreeInfo?.gitStatus?.behind;
	// gh availability is optimistic until the query resolves.
	const ghMissing = ghStatus?.available === false;

	const refreshLandingState = () => {
		if (workspaceId) {
			utils.workspaces.getGitHubStatus.invalidate({ workspaceId });
			utils.workspaces.getWorktreeInfo.invalidate({ workspaceId });
		}
	};

	const createPRMutation = electronTrpc.changes.createPR.useMutation({
		onSuccess: () => {
			toast.success("Pull request created and opened.");
			refreshLandingState();
		},
		onError: (error) =>
			toast.error("Couldn't create pull request.", {
				description: error.message,
			}),
	});

	const mergeMutation = electronTrpc.changes.mergePR.useMutation({
		onSuccess: () => {
			toast.success("Pull request merged.");
			refreshLandingState();
		},
		onError: (error) =>
			toast.error("Couldn't merge pull request.", {
				description: error.message,
			}),
	});

	const rebaseMutation = electronTrpc.changes.rebaseOntoDefault.useMutation({
		onSuccess: (result) => {
			if (result.success) {
				setConflict(null);
				toast.success(`Rebased onto ${result.rebasedOnto}.`);
				refreshLandingState();
			} else {
				setShowAllConflicts(false);
				setConflict({
					files: result.conflictedFiles,
					branch: result.defaultBranch,
				});
			}
		},
		onError: () =>
			toast.error(`Couldn't rebase onto ${defaultBranch}.`, {
				description: "Your branch was not changed.",
			}),
	});

	const isPending =
		createPRMutation.isPending ||
		mergeMutation.isPending ||
		rebaseMutation.isPending;

	const prState = pr?.state;
	const showCreatePR = !pr || prState === "closed";
	const showMerge = prState === "open" || prState === "draft";
	const isMerged = prState === "merged";

	const mergeHint = ghMissing
		? "Install GitHub CLI to merge this pull request."
		: prState === "draft"
			? "Mark the pull request ready before merging."
			: undefined;
	const createPRHint = ghMissing
		? "Install GitHub CLI to create a pull request."
		: undefined;

	// Nothing actionable and no conflict to report → render nothing.
	if (!showCreatePR && !showMerge && !needsRebase && !isMerged && !conflict) {
		return null;
	}

	return (
		<div className="border-b border-r border-border bg-background">
			<div className="flex items-center gap-2 px-3 py-2 min-h-[40px]">
				<div className="flex items-center gap-2 flex-1 min-w-0">
					{needsRebase && (
						<Badge
							variant="outline"
							className="border-[var(--argus-iris-waiting)]/40 text-[var(--argus-iris-waiting)] dark:text-[var(--argus-iris-waiting)] gap-1"
						>
							<LuTriangleAlert className="size-3" />
							Behind {defaultBranch} by {behindCount ?? "?"}
						</Badge>
					)}
					{prState === "draft" && <Badge variant="secondary">Draft</Badge>}
					{isMerged && <Badge variant="secondary">Merged</Badge>}
				</div>

				<div className="flex items-center gap-1.5">
					{needsRebase && (
						<Hint text={`Replay this branch onto ${defaultBranch}.`}>
							<Button
								type="button"
								size="xs"
								variant="outline"
								disabled={isPending}
								aria-label={`Rebase branch onto ${defaultBranch}`}
								aria-busy={rebaseMutation.isPending}
								onClick={() => rebaseMutation.mutate({ worktreePath })}
							>
								{rebaseMutation.isPending ? (
									<>
										<Spinner className="size-3.5" />
										Rebasing…
									</>
								) : (
									<>
										<LuRotateCcw className="size-3.5" />
										Rebase onto {defaultBranch}
									</>
								)}
							</Button>
						</Hint>
					)}

					{showCreatePR && (
						<Hint text={createPRHint}>
							<Button
								type="button"
								size="xs"
								disabled={isPending || ghMissing}
								aria-label="Create pull request"
								aria-busy={createPRMutation.isPending}
								onClick={() => createPRMutation.mutate({ worktreePath })}
							>
								{createPRMutation.isPending ? (
									<>
										<Spinner className="size-3.5" />
										Creating PR…
									</>
								) : (
									<>
										<LuGitPullRequest className="size-3.5" />
										Create PR
									</>
								)}
							</Button>
						</Hint>
					)}

					{showMerge && (
						<div className="flex items-center">
							<Hint text={mergeHint}>
								<Button
									type="button"
									size="xs"
									disabled={isPending || ghMissing || prState === "draft"}
									aria-label={`Merge pull request using ${strategy}`}
									aria-busy={mergeMutation.isPending}
									className="rounded-r-none"
									onClick={() =>
										mergeMutation.mutate({ worktreePath, strategy })
									}
								>
									{mergeMutation.isPending ? (
										<>
											<Spinner className="size-3.5" />
											Merging…
										</>
									) : (
										<>
											<LuGitMerge className="size-3.5" />
											{STRATEGY_LABELS[strategy].action}
										</>
									)}
								</Button>
							</Hint>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										size="xs"
										disabled={isPending || ghMissing || prState === "draft"}
										aria-label="Choose merge strategy"
										className="rounded-l-none border-l border-l-primary-foreground/20 px-1.5"
									>
										<LuChevronDown className="size-3.5" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="min-w-[160px]">
									{(Object.keys(STRATEGY_LABELS) as MergeStrategy[]).map(
										(s) => (
											<DropdownMenuItem
												key={s}
												onClick={() => setStrategy(s)}
												className="flex items-center justify-between gap-4"
											>
												<span>{STRATEGY_LABELS[s].menu}</span>
												{s === strategy && (
													<LuCheck className="size-3.5 text-muted-foreground" />
												)}
											</DropdownMenuItem>
										),
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					)}
				</div>
			</div>

			{conflict && (
				<ConflictBanner
					conflict={conflict}
					showAll={showAllConflicts}
					onShowAll={() => setShowAllConflicts(true)}
					onDismiss={() => setConflict(null)}
				/>
			)}
		</div>
	);
}

/**
 * Wraps a control in an explanatory tooltip when a hint is present (e.g. a
 * disabled action). The focusable span keeps the tooltip reachable by keyboard
 * even though the underlying button is disabled.
 */
function Hint({ text, children }: { text?: string; children: ReactNode }) {
	if (!text) return <>{children}</>;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span tabIndex={0} className="inline-flex">
					{children}
				</span>
			</TooltipTrigger>
			<TooltipContent side="bottom" showArrow={false}>
				{text}
			</TooltipContent>
		</Tooltip>
	);
}

function ConflictBanner({
	conflict,
	showAll,
	onShowAll,
	onDismiss,
}: {
	conflict: { files: string[]; branch: string };
	showAll: boolean;
	onShowAll: () => void;
	onDismiss: () => void;
}) {
	const shown = showAll
		? conflict.files
		: conflict.files.slice(0, CONFLICT_PREVIEW_COUNT);
	const hiddenCount = conflict.files.length - shown.length;

	return (
		<div className="flex items-start gap-2 px-3 py-2.5 border-t border-destructive/30 bg-destructive/10 text-xs">
			<LuTriangleAlert className="size-4 shrink-0 text-destructive mt-0.5" />
			<div className="flex-1 min-w-0 space-y-1.5">
				<div className="font-medium text-destructive">
					Rebase stopped by conflicts
				</div>
				<p className="text-muted-foreground">
					Your branch was restored. Resolve these files in the terminal, then
					rebase again.
				</p>
				<ul className="font-mono text-[11px] space-y-0.5 select-text">
					{shown.map((file) => (
						<li key={file} className="break-all">
							{file}
						</li>
					))}
				</ul>
				{hiddenCount > 0 && (
					<button
						type="button"
						onClick={onShowAll}
						className="text-muted-foreground hover:text-foreground underline"
					>
						Show {hiddenCount} more
					</button>
				)}
			</div>
			<button
				type="button"
				onClick={onDismiss}
				className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent"
				aria-label="Dismiss rebase conflict details"
			>
				<LuX className="size-3.5" />
			</button>
		</div>
	);
}
