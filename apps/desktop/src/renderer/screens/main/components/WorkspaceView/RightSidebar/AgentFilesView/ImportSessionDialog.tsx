import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import { LuFileText, LuFolderGit2 } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface ImportSessionDialogProps {
	workspaceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

function relativeTime(ms: number): string {
	const diff = Date.now() - ms;
	const mins = Math.round(diff / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.round(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.round(hrs / 24);
	return `${days}d ago`;
}

/**
 * Session picker for importing a native `claude` CLI session into the current
 * Workspace (issue #27). Lists discovered sessions grouped by the repo they ran
 * in — ADE agents own their own fresh worktree, so the sessions worth
 * importing are the ones the user ran directly in the source repo, which is why
 * we surface every discovered repo and let the user pick rather than scoping to
 * the (empty) worktree. Selecting a session binds it to this Workspace.
 */
export function ImportSessionDialog({
	workspaceId,
	open,
	onOpenChange,
}: ImportSessionDialogProps) {
	const utils = electronTrpc.useUtils();
	const { data: groups, isLoading } = electronTrpc.claudeSessions.list.useQuery(
		undefined,
		{ enabled: open },
	);
	const importSession = electronTrpc.claudeSessions.import.useMutation();
	const [importingId, setImportingId] = useState<string | null>(null);

	const handleImport = async (sessionId: string, sourceRepoPath: string) => {
		setImportingId(sessionId);
		try {
			const result = await importSession.mutateAsync({
				workspaceId,
				sessionId,
				sourceRepoPath,
			});
			await utils.workspaces.listAgentFiles.invalidate({ workspaceId });
			toast.success(
				`Imported session (${result.messageCount} messages)` +
					(result.memoryFilesImported.length
						? ` · memory: ${result.memoryFilesImported.join(", ")}`
						: ""),
			);
			onOpenChange(false);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to import session",
			);
		} finally {
			setImportingId(null);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle>Import Claude session</DialogTitle>
					<DialogDescription>
						Attach an existing native <code>claude</code> CLI session to this
						Workspace. The transcript is bound to the worktree (resumable with
						<code> claude --resume</code>), rendered into Agent Files, and any
						memory notes are carried over.
					</DialogDescription>
				</DialogHeader>

				<div className="flex max-h-[52vh] flex-col gap-4 overflow-auto py-1">
					{isLoading && (
						<div className="py-8 text-center text-sm text-muted-foreground">
							Scanning ~/.claude/projects…
						</div>
					)}
					{!isLoading && (!groups || groups.length === 0) && (
						<div className="py-8 text-center text-sm text-muted-foreground">
							No native Claude sessions found on this machine.
						</div>
					)}
					{groups?.map((group) => (
						<div key={group.repoPath} className="flex flex-col gap-1">
							<div className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
								<LuFolderGit2 className="size-3.5 shrink-0" />
								<span className="truncate" title={group.repoPath}>
									{group.repoPath}
								</span>
							</div>
							{group.sessions.map((session) => {
								const busy = importingId === session.sessionId;
								return (
									<button
										key={session.sessionId}
										type="button"
										disabled={importSession.isPending}
										onClick={() =>
											handleImport(session.sessionId, group.repoPath)
										}
										className="flex items-start gap-2 rounded-md border border-border/60 px-3 py-2 text-left hover:bg-tertiary/20 disabled:opacity-50"
									>
										<LuFileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
										<div className="flex min-w-0 flex-1 flex-col">
											<span className="truncate text-sm text-foreground/90">
												{session.title ||
													session.firstPrompt ||
													session.sessionId}
											</span>
											<span className="truncate text-xs text-muted-foreground">
												{session.messageCount} messages ·{" "}
												{relativeTime(session.lastModified)}
												{session.gitBranch ? ` · ${session.gitBranch}` : ""}
											</span>
										</div>
										{busy && (
											<span className="shrink-0 self-center text-xs text-muted-foreground">
												Importing…
											</span>
										)}
									</button>
								);
							})}
						</div>
					))}
				</div>
			</DialogContent>
		</Dialog>
	);
}
