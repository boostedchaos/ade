import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuDownload } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import { ImportSessionDialog } from "./ImportSessionDialog";

type AgentFileGroup = "Memory" | "Skills" | "Mail" | "Worktree" | "Imported";

interface AgentFileEntry {
	label: string;
	group: AgentFileGroup;
	absolutePath: string;
	relativeToWorktree: string | null;
	sizeBytes: number | null;
	modifiedAt: number | null;
}

/** "1.2k" / "840" — the right-aligned size in the 2a panel. */
function formatSize(bytes: number | null): string | null {
	if (bytes === null) return null;
	if (bytes < 1000) return String(bytes);
	return `${(bytes / 1000).toFixed(1)}k`;
}

/**
 * A file counts as "just written" for two minutes. The 2a mock shows the
 * recently-written file highlighted with `now` where its size would be; this
 * is the window that earns that treatment.
 */
const RECENT_WRITE_MS = 2 * 60 * 1000;

/**
 * Paths whose mtime changed since the last render — Argus movement 4.
 *
 * Keyed on the CHANGE, not on "the file is recent": flashing everything with a
 * fresh mtime would replay the animation on every mount and every refetch,
 * which is the "nothing animates on load" rule broken in a way that only shows
 * up when someone opens the panel next to a busy agent.
 */
function useJustWritten(files: AgentFileEntry[] | undefined): Set<string> {
	const previous = useRef<Map<string, number> | null>(null);
	const [flashing, setFlashing] = useState<Set<string>>(new Set());

	// Detect: which paths got a NEWER mtime than the last time we looked.
	useEffect(() => {
		if (!files) return;
		const current = new Map(
			files.map((f) => [f.absolutePath, f.modifiedAt ?? 0]),
		);
		const prior = previous.current;
		previous.current = current;
		// First load records the baseline and animates nothing.
		if (!prior) return;

		const changed = new Set<string>();
		for (const [path, mtime] of current) {
			const before = prior.get(path);
			if (before !== undefined && mtime > before) changed.add(path);
		}
		if (changed.size === 0) return;
		setFlashing(changed);
	}, [files]);

	// Clear: keyed on `flashing` itself, NOT on `files`.
	//
	// These have to be separate effects. When the clear timer lived in the
	// detect effect, any later `files` change that found nothing new ran that
	// effect's cleanup — cancelling the pending clear — and then returned early
	// without scheduling a replacement, so the row stayed lit forever. The
	// reachable trigger is an agent writing a NEW memory file: that changes the
	// array without raising any existing file's mtime. Keying the timer on
	// `flashing` makes the invariant hold by construction — whenever something
	// is flashing, a timer to stop it exists.
	useEffect(() => {
		if (flashing.size === 0) return;
		const timer = setTimeout(() => setFlashing(new Set()), MEMORY_FLASH_MS);
		return () => clearTimeout(timer);
	}, [flashing]);

	return flashing;
}

/** Matches the .argus-memory-write keyframes in globals.css (90ms in, 600ms out). */
const MEMORY_FLASH_MS = 690;

const GROUP_ORDER: AgentFileGroup[] = [
	"Memory",
	"Skills",
	"Mail",
	"Worktree",
	"Imported",
];

export function AgentFilesView() {
	const { workspaceId } = useParams({ strict: false });
	const [importOpen, setImportOpen] = useState(false);
	const { data: files, isLoading } =
		electronTrpc.workspaces.listAgentFiles.useQuery(
			{ workspaceId: workspaceId ?? "" },
			{ enabled: !!workspaceId },
		);

	const addFileViewerPane = useTabsStore((s) => s.addFileViewerPane);
	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const agentName = workspace?.name ?? null;
	const justWritten = useJustWritten(files);

	const handleActivate = useCallback(
		(entry: AgentFileEntry) => {
			if (!workspaceId) return;
			// In-worktree files open via the worktree-relative path; out-of-worktree
			// memory/skill files open via their absolute path. Both are pinned so
			// they persist as real tabs.
			if (entry.relativeToWorktree) {
				addFileViewerPane(workspaceId, {
					filePath: entry.relativeToWorktree,
					isPinned: true,
				});
				return;
			}
			addFileViewerPane(workspaceId, {
				filePath: entry.label,
				absolutePath: entry.absolutePath,
				isPinned: true,
			});
		},
		[workspaceId, addFileViewerPane],
	);

	const grouped = useMemo(() => {
		const map = new Map<AgentFileGroup, AgentFileEntry[]>();
		for (const entry of files ?? []) {
			const list = map.get(entry.group) ?? [];
			list.push(entry);
			map.set(entry.group, list);
		}
		return map;
	}, [files]);

	if (!workspaceId) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
				No agent selected
			</div>
		);
	}

	const hasFiles = !!files && files.length > 0;

	return (
		<div className="flex flex-col flex-1 min-h-0">
			<div className="flex items-center justify-between px-3 py-1.5 border-b border-border/40">
				<span className="argus-label">
					Memory{agentName ? ` · ${agentName}` : ""}
				</span>
				<button
					type="button"
					onClick={() => setImportOpen(true)}
					className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-tertiary/20 hover:text-foreground transition-colors"
					title="Import a native Claude CLI session into this Workspace"
				>
					<LuDownload className="size-3.5 shrink-0" />
					Import session
				</button>
			</div>

			<div className="flex flex-col flex-1 min-h-0 overflow-auto py-1">
				{isLoading && (
					<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
						Loading agent files…
					</div>
				)}
				{!isLoading && !hasFiles && (
					<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4">
						No agent files yet
					</div>
				)}
				{!isLoading &&
					hasFiles &&
					GROUP_ORDER.map((group) => {
						const entries = grouped.get(group);
						if (!entries || entries.length === 0) return null;
						return (
							<div key={group} className="flex flex-col">
								<div className="px-3 pt-2 pb-1 argus-label">{group}</div>
								{entries.map((entry) => {
									const isRecent =
										entry.modifiedAt !== null &&
										Date.now() - entry.modifiedAt < RECENT_WRITE_MS;
									// Nested files (skills/x/SKILL.md, memories/y.md) indent
									// under their group, as in the 2a mock.
									const depth = entry.label.split("/").length - 1;
									const size = formatSize(entry.sizeBytes);
									return (
										<button
											key={entry.absolutePath}
											type="button"
											onClick={() => handleActivate(entry)}
											className={`flex items-center gap-2 px-3 py-1 text-left font-mono transition-colors${
												justWritten.has(entry.absolutePath)
													? " argus-memory-write"
													: ""
											}`}
											style={{
												fontSize: "12px",
												paddingInlineStart: 12 + depth * 20,
												color: isRecent
													? "var(--argus-iris-working)"
													: "var(--argus-text-body)",
												backgroundColor: isRecent
													? "var(--argus-wash-accent-soft)"
													: undefined,
												borderRadius: "var(--argus-radius-surface)",
											}}
											title={entry.absolutePath}
										>
											<span className="truncate flex-1">{entry.label}</span>
											{/* `now` for a just-written file, otherwise the real
											    size. Nothing at all when the stat failed — an
											    invented size would be worse than a blank. */}
											{isRecent ? (
												<span className="shrink-0">now</span>
											) : (
												size && (
													<span
														className="shrink-0"
														style={{ color: "var(--argus-text-label)" }}
													>
														{size}
													</span>
												)
											)}
										</button>
									);
								})}
							</div>
						);
					})}
			</div>

			<ImportSessionDialog
				workspaceId={workspaceId}
				open={importOpen}
				onOpenChange={setImportOpen}
			/>
		</div>
	);
}
