import { z } from "zod";

/**
 * Git status for a worktree
 */
export const gitStatusSchema = z.object({
	branch: z.string(),
	needsRebase: z.boolean(),
	ahead: z.number().optional(),
	behind: z.number().optional(),
	lastRefreshed: z.number(),
});

export type GitStatus = z.infer<typeof gitStatusSchema>;

/**
 * GitHub check item
 */
export const checkItemSchema = z.object({
	name: z.string(),
	status: z.enum(["success", "failure", "pending", "skipped", "cancelled"]),
	url: z.string().optional(),
});

export type CheckItem = z.infer<typeof checkItemSchema>;

/**
 * GitHub PR status
 */
export const gitHubStatusSchema = z.object({
	pr: z
		.object({
			number: z.number(),
			title: z.string(),
			url: z.string(),
			state: z.enum(["open", "draft", "merged", "closed"]),
			mergedAt: z.number().optional(),
			additions: z.number(),
			deletions: z.number(),
			reviewDecision: z.enum(["approved", "changes_requested", "pending"]),
			checksStatus: z.enum(["success", "failure", "pending", "none"]),
			checks: z.array(checkItemSchema),
		})
		.nullable(),
	repoUrl: z.string(),
	branchExistsOnRemote: z.boolean(),
	lastRefreshed: z.number(),
});

export type GitHubStatus = z.infer<typeof gitHubStatusSchema>;

export const EXECUTION_MODES = [
	"split-pane",
	"new-tab",
	"new-tab-split-pane",
] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export function normalizeExecutionMode(mode: unknown): ExecutionMode {
	if (
		mode === "split-pane" ||
		mode === "new-tab" ||
		mode === "new-tab-split-pane"
	) {
		return mode;
	}

	return "split-pane";
}

/**
 * Terminal preset
 */
export const terminalPresetSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	cwd: z.string(),
	commands: z.array(z.string()),
	pinnedToBar: z.boolean().optional(),
	isDefault: z.boolean().optional(),
	applyOnWorkspaceCreated: z.boolean().optional(),
	applyOnNewTab: z.boolean().optional(),
	executionMode: z.enum(EXECUTION_MODES).optional(),
});

export type TerminalPreset = z.infer<typeof terminalPresetSchema>;

/**
 * Workspace type
 */
export const workspaceTypeSchema = z.enum(["worktree", "branch"]);

export type WorkspaceType = z.infer<typeof workspaceTypeSchema>;

/**
 * Agent runtime — which CLI drives an agent (ADE "Agent" = workspace).
 * Mirrors AGENT_TYPES in @superset/shared/src/agent-command.ts, which keys
 * AGENT_PRESET_COMMANDS (the runtime -> launch-command map). Kept in sync
 * manually because local-db does not depend on @superset/shared.
 */
export const AGENT_RUNTIMES = [
	"claude",
	"codex",
	"gemini",
	"opencode",
	"copilot",
	"cursor-agent",
	"kimi",
	"minimax",
	"glm",
] as const;

export const agentRuntimeSchema = z.enum(AGENT_RUNTIMES);

export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;

/**
 * External apps that can be opened
 */
export const EXTERNAL_APPS = [
	"finder",
	"vscode",
	"vscode-insiders",
	"cursor",
	"antigravity",
	"zed",
	"sublime",
	"xcode",
	"iterm",
	"warp",
	"terminal",
	"ghostty",
	// JetBrains IDEs
	"intellij",
	"webstorm",
	"pycharm",
	"phpstorm",
	"rubymine",
	"goland",
	"clion",
	"rider",
	"datagrip",
	"appcode",
	"fleet",
	"rustrover",
] as const;

export type ExternalApp = (typeof EXTERNAL_APPS)[number];

/** Apps that are not editors/IDEs and should not be set as the global default editor. */
export const NON_EDITOR_APPS: readonly ExternalApp[] = [
	"finder",
	"iterm",
	"warp",
	"terminal",
	"ghostty",
] as const;

/**
 * Terminal link behavior options
 */
export const TERMINAL_LINK_BEHAVIORS = [
	"external-editor",
	"file-viewer",
] as const;

export type TerminalLinkBehavior = (typeof TERMINAL_LINK_BEHAVIORS)[number];

/**
 * Branch prefix modes for workspace branch naming
 */
export const BRANCH_PREFIX_MODES = [
	"none",
	"github",
	"author",
	"custom",
] as const;

export type BranchPrefixMode = (typeof BRANCH_PREFIX_MODES)[number];

export const FILE_OPEN_MODES = ["split-pane", "new-tab"] as const;

export type FileOpenMode = (typeof FILE_OPEN_MODES)[number];

/**
 * How an ACP agent session handles a tool that asks permission.
 *
 * `auto-approve` runs the adapter in its bypass mode, where it never asks —
 * the behavior every ACP pane has had so far. `prompt` moves the session out
 * of bypass so `session/request_permission` actually fires and the pane can
 * put the decision in front of the user.
 *
 * Applies to NEW sessions: the policy is the session's MODE, set during the
 * handshake, and switching it mid-session is out of scope for Phase 6.
 */
export const ACP_PERMISSION_POLICIES = ["auto-approve", "prompt"] as const;

export type AcpPermissionPolicy = (typeof ACP_PERMISSION_POLICIES)[number];

/**
 * What a "+"-created agent session opens as (Phase 6 B3/B4).
 *
 * `acp` is the default: a Claude Code agent session in a worktree opens as an
 * ACP conversation pane. `terminal` is the global escape hatch that restores
 * the pre-Phase-6 behavior everywhere — the CLI in a PTY.
 *
 * Only the DEFAULT is stored. Both explicit menu items (ACP session, agent
 * session in a terminal) ignore this and open what they name.
 */
export const ACP_DEFAULT_VIEWS = ["acp", "terminal"] as const;

export type AcpDefaultView = (typeof ACP_DEFAULT_VIEWS)[number];
