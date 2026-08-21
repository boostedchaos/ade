/**
 * Smoke coverage for the default flip (B3). An independent author follows.
 */

import { describe, expect, it } from "bun:test";
import { resolveAgentSessionView } from "./acp-flip";

const claudeWithWorktree = {
	runtime: "claude" as const,
	worktreePath: "/repo/worktree",
	defaultView: "acp" as const,
};

describe("resolveAgentSessionView", () => {
	it("opens ACP for a Claude Code agent with a worktree", () => {
		expect(resolveAgentSessionView(claudeWithWorktree)).toBe("acp");
	});

	it("stays terminal without a worktree", () => {
		expect(
			resolveAgentSessionView({ ...claudeWithWorktree, worktreePath: null }),
		).toBe("terminal");
	});

	it("stays terminal for a non-Claude runtime", () => {
		expect(
			resolveAgentSessionView({ ...claudeWithWorktree, runtime: "codex" }),
		).toBe("terminal");
	});

	it("stays terminal for the OpenRouter claude-family runtimes", () => {
		// They ARE `isClaudeFamilyRuntime`, and they are deliberately excluded:
		// their model comes from flags in the terminal command string, which the
		// ACP path does not write.
		for (const runtime of ["kimi", "minimax", "glm"] as const) {
			expect(resolveAgentSessionView({ ...claudeWithWorktree, runtime })).toBe(
				"terminal",
			);
		}
	});

	it("stays terminal when the global setting says so", () => {
		expect(
			resolveAgentSessionView({
				...claudeWithWorktree,
				defaultView: "terminal",
			}),
		).toBe("terminal");
	});

	it("an explicit view overrides the setting in BOTH directions", () => {
		expect(
			resolveAgentSessionView({
				...claudeWithWorktree,
				defaultView: "terminal",
				forceView: "acp",
			}),
		).toBe("acp");
		expect(
			resolveAgentSessionView({ ...claudeWithWorktree, forceView: "terminal" }),
		).toBe("terminal");
	});
});
