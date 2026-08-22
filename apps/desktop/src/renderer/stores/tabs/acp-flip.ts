import type { AcpDefaultView, AgentRuntime } from "@superset/local-db";

/**
 * What an agent session opens as (Phase 6 B3).
 *
 * Pure and separate from `useAgentSession` because this is the decision the
 * flip IS: everything else in that hook is plumbing, and a wrong answer here
 * silently changes what every "+" does.
 */
export type AgentSessionView = "acp" | "terminal";

/**
 * The ONE runtime the ACP pane can serve.
 *
 * Not `isClaudeFamilyRuntime`, deliberately. That predicate also covers
 * `kimi` / `minimax` / `glm`, which are the `claude` CLI pointed at OpenRouter
 * by env vars and a `--model` flag *in the terminal command string*. The ACP
 * path does not write a command line — it spawns the adapter — so flipping
 * those runtimes would quietly run Claude instead of the model the user chose.
 * They stay on the terminal path until an ACP session can carry that config.
 */
const ACP_RUNTIME: AgentRuntime = "claude";

export interface AgentSessionViewInput {
	runtime: AgentRuntime | null | undefined;
	/** The agent's worktree. Also the ACP session's `fs/*` sandbox root. */
	worktreePath: string | null | undefined;
	/** The global default from settings (B4). */
	defaultView: AcpDefaultView;
	/**
	 * An explicit menu choice, which overrides everything above — including a
	 * `defaultView` of `"terminal"`. A user who picks "ACP session" by name
	 * gets one.
	 */
	forceView?: AgentSessionView;
}

export function resolveAgentSessionView(
	input: AgentSessionViewInput,
): AgentSessionView {
	// No worktree, no session: `cwd` is required by `createAcpPane` because a
	// session opened in the wrong directory is worse than one that fails to
	// open. Checked FIRST, ahead of `forceView`, so an "acp" verdict is proof a
	// cwd exists whatever produced it — the invariant `useAgentSession` states
	// at its call site, and the only guard a future caller without its own
	// `worktreePath` test would have. An explicit menu choice outranks the
	// setting and the runtime; it cannot conjure a directory to run in.
	if (!input.worktreePath) return "terminal";
	if (input.forceView) return input.forceView;
	// The global escape hatch: one setting restores the pre-Phase-6 behavior
	// everywhere, without touching any of the call sites.
	if (input.defaultView === "terminal") return "terminal";
	if (input.runtime !== ACP_RUNTIME) return "terminal";
	return "acp";
}
