/**
 * The default flip as a full matrix (B3).
 *
 * `acp-flip.test.ts` walks one input at a time off a fixed base. This walks
 * every combination that reaches the resolver at runtime — every runtime the
 * database can hold, both settings values, present and absent worktree — and
 * asserts the single property the flip actually has to satisfy:
 *
 *   ACP is reachable ONLY as (runtime === "claude") AND a worktree AND the
 *   setting left on "acp"; everything else is a terminal.
 *
 * A per-axis suite passes against a resolver that got a PAIR of conditions
 * wrong in compensating directions. This one does not.
 */

import { describe, expect, it } from "bun:test";
import { AGENT_RUNTIMES } from "@superset/local-db/schema/zod";
import { type AgentSessionView, resolveAgentSessionView } from "./acp-flip";

/**
 * Every runtime value the schema allows, read off the registry rather than
 * listed here — a hand-kept copy silently stops covering the runtimes added
 * after it was written, which is exactly the case a flip matrix exists for.
 */
const RUNTIMES = AGENT_RUNTIMES;

const WORKTREES = [
	{ label: "with a worktree", value: "/repo/worktree" },
	{ label: "with no worktree", value: null },
	{ label: "with an undefined worktree", value: undefined },
	// The falsy string a cleared column leaves. It is not a directory, and an
	// ACP session opened at "" would run in the app's own cwd.
	{ label: "with an empty worktree path", value: "" },
] as const;

const DEFAULT_VIEWS = ["acp", "terminal"] as const;

describe("resolveAgentSessionView — full matrix", () => {
	it("opens ACP for exactly one combination and terminal for the rest", () => {
		const acpCombinations: string[] = [];

		for (const runtime of RUNTIMES) {
			for (const worktree of WORKTREES) {
				for (const defaultView of DEFAULT_VIEWS) {
					const view = resolveAgentSessionView({
						runtime,
						worktreePath: worktree.value,
						defaultView,
					});
					if (view === "acp") {
						acpCombinations.push(`${runtime} ${worktree.label} ${defaultView}`);
					}
				}
			}
		}

		expect(acpCombinations).toEqual(["claude with a worktree acp"]);
	});

	it("treats a null or undefined runtime as terminal", () => {
		for (const runtime of [null, undefined]) {
			expect(
				resolveAgentSessionView({
					runtime,
					worktreePath: "/repo/worktree",
					defaultView: "acp",
				}),
			).toBe("terminal");
		}
	});

	it("the setting is a hard escape hatch: terminal wins over every runtime", () => {
		// The half of the matrix above that a per-axis suite proves for one
		// runtime only. A setting that only reached the claude branch would leave
		// the escape hatch working and untested for everything else.
		for (const runtime of RUNTIMES) {
			expect(
				resolveAgentSessionView({
					runtime,
					worktreePath: "/repo/worktree",
					defaultView: "terminal",
				}),
			).toBe("terminal");
		}
	});
});

describe("resolveAgentSessionView — the OpenRouter claude-family runtimes", () => {
	it("keeps kimi / minimax / glm on the terminal even though they run the claude CLI", () => {
		// They ARE `isClaudeFamilyRuntime`, and the ACP path does not write a
		// command line, so flipping them would run Claude instead of the model
		// the user picked — a silent substitution, not a broken pane.
		for (const runtime of ["kimi", "minimax", "glm"] as const) {
			expect(
				resolveAgentSessionView({
					runtime,
					worktreePath: "/repo/worktree",
					defaultView: "acp",
				}),
			).toBe("terminal");
		}
	});

	it("PROVES THE EXCLUSION IS BY RUNTIME: plain claude on the same input flips", () => {
		expect(
			resolveAgentSessionView({
				runtime: "claude",
				worktreePath: "/repo/worktree",
				defaultView: "acp",
			}),
		).toBe("acp");
	});
});

describe("resolveAgentSessionView — an explicit menu choice", () => {
	it("forceView wins over the setting, both ways", () => {
		for (const forceView of ["acp", "terminal"] as AgentSessionView[]) {
			for (const defaultView of DEFAULT_VIEWS) {
				expect(
					resolveAgentSessionView({
						runtime: "claude",
						worktreePath: "/repo/worktree",
						defaultView,
						forceView,
					}),
				).toBe(forceView);
			}
		}
	});

	it("forceView terminal wins over every ACP-eligible input", () => {
		expect(
			resolveAgentSessionView({
				runtime: "claude",
				worktreePath: "/repo/worktree",
				defaultView: "acp",
				forceView: "terminal",
			}),
		).toBe("terminal");
	});

	/**
	 * The invariant `useAgentSession.ts` asserts at its call site, pinned here.
	 *
	 * The worktree requirement is checked BEFORE `forceView`, so an "acp"
	 * verdict is proof a cwd exists no matter which input produced it. That is
	 * what lets the call site treat its own `worktreePath` test as type
	 * narrowing rather than a second rule — and it is what the next caller,
	 * which may have no such test, is entitled to rely on.
	 *
	 * An explicit menu choice still wins over the setting and the runtime; it
	 * cannot conjure a directory to run in.
	 */
	it("forceView acp is REFUSED for a workspace with no worktree", () => {
		for (const worktreePath of [null, undefined, ""]) {
			expect(
				resolveAgentSessionView({
					runtime: "claude",
					worktreePath,
					defaultView: "acp",
					forceView: "acp",
				}),
			).toBe("terminal");
		}
		// And for a runtime the ACP pane cannot serve at all.
		expect(
			resolveAgentSessionView({
				runtime: "codex",
				worktreePath: null,
				defaultView: "terminal",
				forceView: "acp",
			}),
		).toBe("terminal");
	});

	it("PROVES THE WORKTREE IS THE THING SAYING NO: the same force with one flips", () => {
		expect(
			resolveAgentSessionView({
				runtime: "claude",
				worktreePath: "/repo/worktree",
				defaultView: "terminal",
				forceView: "acp",
			}),
		).toBe("acp");
	});
});
