import type { AgentRuntime, TerminalPreset } from "@superset/local-db";
import {
	AGENT_LABELS,
	buildAgentSessionCommands,
	isClaudeFamilyRuntime,
} from "@superset/shared/agent-command";
import { useCallback } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { type AgentSessionView, resolveAgentSessionView } from "./acp-flip";
import { useTabsStore } from "./store";
import { useTabsWithPresets } from "./useTabsWithPresets";

/** Minimal shape needed to spawn an agent's runtime CLI session. */
export interface AgentSessionWorkspace {
	id: string;
	/**
	 * Display name for the session tab — pass the agent's (workspace's) name so
	 * tabs carry the agent's durable identity instead of a generic runtime label
	 * (issue #36). Falls back to the runtime label when absent.
	 */
	name?: string | null;
	runtime?: AgentRuntime | null;
	worktreePath?: string | null;
}

/**
 * Spawns an agent's runtime CLI in a new terminal session tab.
 *
 * A "session" is just a normal terminal tab. Given an agent (workspace) with a
 * runtime, we build a synthetic TerminalPreset that launches the runtime's CLI
 * (via AGENT_PRESET_COMMANDS) in the agent's worktree and open it as a new tab.
 * When the agent has no runtime we fall back to a plain shell tab.
 *
 * Re-opening an agent that already has a Claude conversation resumes THAT
 * conversation deterministically (`claude --resume <id>`, newest transcript for
 * the worktree) instead of typing a bare `claude` that would start a brand-new
 * session; only a worktree with no prior transcript starts fresh (issue #49).
 *
 * Since Phase 6 (B3) a Claude Code agent with a worktree opens as an ACP
 * CONVERSATION pane instead, unless the caller names a view or the global
 * setting says terminal. That path resolves the SAME newest-conversation id
 * and hands it to the pane, which asks for it on mount (A8/B1) — the pane's
 * own restore only covers a pane that already ran a session, so without this
 * the flip would have started every "+" fresh.
 */
export function useAgentSession() {
	const { openPreset, addTab } = useTabsWithPresets();
	const utils = electronTrpc.useUtils();

	/**
	 * Resolve the agent's most recent Claude session id for its worktree, so the
	 * launch can `--resume` that exact conversation. Returns null when the runtime
	 * isn't claude-family, there's no worktree, or the worktree has no prior
	 * Claude transcript — in which case the caller starts a fresh session.
	 */
	const resolveResumeSessionId = useCallback(
		async (
			runtime: AgentRuntime,
			worktreePath: string | undefined,
		): Promise<string | null> => {
			if (!worktreePath || !isClaudeFamilyRuntime(runtime)) return null;
			try {
				// `list` returns sessions newest-first, grouped by repo; the newest
				// transcript for this worktree is the conversation to resume.
				const groups = await utils.claudeSessions.list.fetch({
					repoPath: worktreePath,
				});
				return groups[0]?.sessions[0]?.sessionId ?? null;
			} catch {
				// Never block (or fail) a launch on session discovery — start fresh.
				return null;
			}
		},
		[utils],
	);

	const spawnAgentSession = useCallback(
		async (
			workspace: AgentSessionWorkspace,
			options?: { view?: AgentSessionView },
		) => {
			const { id, name, runtime, worktreePath } = workspace;
			const cwd = worktreePath || undefined;

			// Read per launch, not per render: a settings change applies to the
			// next session without a restart, matching how the permission policy
			// is read on the host side. A failed read must not decide the view —
			// fall back to the default the procedure itself would have returned.
			const defaultView = await utils.settings.getAcpDefaultView
				.fetch()
				.catch(() => "acp" as const);

			const view = resolveAgentSessionView({
				runtime,
				worktreePath,
				defaultView,
				...(options?.view ? { forceView: options.view } : {}),
			});
			// The `worktreePath` test is type narrowing, not a second rule —
			// `resolveAgentSessionView` refuses "acp" without one before it looks
			// at anything else.
			if (view === "acp" && worktreePath) {
				// Resume parity with the terminal path (A8). The ACP branch used
				// to return here without resolving anything, so the flip silently
				// orphaned the user's newest conversation: `+` had reopened it as
				// `claude --resume <id>` since issue #49, and started a blank one
				// after. The pane asks for the `session/load` itself on mount
				// (B1) — this only has to hand it the id.
				const acpSessionId = runtime
					? await resolveResumeSessionId(runtime, cwd)
					: null;
				return useTabsStore.getState().addAcpTab(id, worktreePath, {
					...(acpSessionId ? { acpSessionId } : {}),
					...(name?.trim() ? { name: name.trim() } : {}),
				});
			}

			if (!runtime) {
				// No runtime configured — open a plain shell in the worktree.
				return addTab(id, { initialCwd: cwd });
			}

			const sessionId = await resolveResumeSessionId(runtime, cwd);

			const preset: TerminalPreset = {
				id: `agent-${runtime}`,
				name: name?.trim() || AGENT_LABELS[runtime] || runtime,
				cwd: worktreePath ?? "",
				commands: buildAgentSessionCommands({ runtime, sessionId }),
				executionMode: "new-tab",
			};

			return openPreset(id, preset, { target: "new-tab" });
		},
		[openPreset, addTab, resolveResumeSessionId, utils],
	);

	return { spawnAgentSession };
}
