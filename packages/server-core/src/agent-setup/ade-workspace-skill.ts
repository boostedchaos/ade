import fs from "node:fs";
import path from "node:path";
import { writeFileIfChanged } from "./agent-wrappers-common";
import { SKILLS_DIR } from "./paths";

/**
 * Installs the bundled `ade-workspace` skill where agents can find it.
 *
 * WHAT THE INVESTIGATION FOUND, since "install it into the agent skill
 * discovery location" turned out to have two different answers in this repo:
 *
 *  1. `agent-setup/` has NO skill mechanism. It installs binaries (BIN_DIR),
 *     hook scripts and per-runtime wrappers. Nothing here has ever written a
 *     skill.
 *  2. `server-core/agent-scaffold.ts` DOES have one, but it is per-ADE-agent:
 *     it seeds `<agent-home>/skills/<name>/SKILL.md` (adopt-persona, ask-agent)
 *     and discovery works because the generated CLAUDE.md bridge in that
 *     agent's worktree points the CLI at that directory in prose. It reaches
 *     ADE-managed agents only — not a human's plain `claude` in a workspace
 *     terminal, which is exactly who this skill is for.
 *
 * So this installs to `~/.ade[-ws]/skills/ade-workspace/SKILL.md`, beside
 * `bin/` and `hooks/`, and `scaffoldAgentSkills` copies it from here into each
 * ADE agent's own skills dir where the bridge already points. The remaining
 * DOCUMENTED GAP: a plain Claude Code session in an ordinary workspace terminal
 * has the file on disk and no reason to read it, because Claude Code discovers
 * skills from `~/.claude/skills` and `<project>/.claude/skills`, and ADE
 * deliberately does not write into either (PROTOCOL.md's Feature 2 amendment
 * dropped the `~/.claude/settings.json` merge for the same reason — ADE manages
 * its OWN files and forces them with `--settings`). Closing it means either a
 * `--settings`-style skill flag, if one exists, or an opt-in `ade cli install`
 * step that symlinks into `~/.claude/skills`. Both are a decision about writing
 * into the user's Claude config, which is not this phase's to make.
 *
 * SOURCE RESOLUTION mirrors ade-cli-bin.ts exactly: prefer a packaged copy
 * under resources, fall back to the repo checkout. A packaged build must copy
 * `skills/` into resources — same Phase 6 packaging item as the compiled CLI
 * entry, and it fails the same loud way if it is forgotten.
 */

export const ADE_WORKSPACE_SKILL_NAME = "ade-workspace";

/** Candidate source paths, most-specific first. */
export function adeWorkspaceSkillCandidates(params: {
	appResourcesDir?: string;
	repoRoot?: string;
}): string[] {
	const candidates: string[] = [];
	if (params.appResourcesDir) {
		candidates.push(
			path.join(
				params.appResourcesDir,
				"skills",
				ADE_WORKSPACE_SKILL_NAME,
				"SKILL.md",
			),
		);
	}
	if (params.repoRoot) {
		candidates.push(
			path.join(
				params.repoRoot,
				"skills",
				ADE_WORKSPACE_SKILL_NAME,
				"SKILL.md",
			),
		);
	}
	return candidates;
}

/** First candidate that exists on disk, or null. */
export function resolveAdeWorkspaceSkillSource(
	candidates: string[],
): string | null {
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return candidate;
		} catch {
			// unreadable candidate is simply not a candidate
		}
	}
	return null;
}

/** Where the installed copy lives. */
export function getAdeWorkspaceSkillPath(): string {
	return path.join(SKILLS_DIR, ADE_WORKSPACE_SKILL_NAME, "SKILL.md");
}

/**
 * Read the bundled skill's text, or null when it cannot be found.
 *
 * Exported so `scaffoldAgentSkills` can seed an ADE agent's own skills dir from
 * the SAME file rather than from a second copy pasted into a TypeScript
 * constant — two copies of a document drift, and the one nobody edits is the
 * one agents read.
 */
export function readAdeWorkspaceSkill(params?: {
	appResourcesDir?: string;
	repoRoot?: string;
}): string | null {
	const source = resolveAdeWorkspaceSkillSource(
		adeWorkspaceSkillCandidates({
			appResourcesDir:
				params?.appResourcesDir ??
				(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
			repoRoot: params?.repoRoot ?? findSkillsRepoRoot(),
		}),
	);
	if (!source) return null;
	try {
		return fs.readFileSync(source, "utf8");
	} catch {
		return null;
	}
}

/**
 * Walk up looking for the monorepo root (the directory containing `skills/`).
 * Undefined in a packaged build, where resources is the right lookup.
 */
export function findSkillsRepoRoot(startDir = __dirname): string | undefined {
	let dir = startDir;
	for (let depth = 0; depth < 10; depth += 1) {
		try {
			if (
				fs.existsSync(
					path.join(dir, "skills", ADE_WORKSPACE_SKILL_NAME, "SKILL.md"),
				)
			) {
				return dir;
			}
		} catch {
			// keep walking
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/**
 * Materialise the installed copy. Idempotent via writeFileIfChanged, because
 * setupAgentHooks() runs on every app boot.
 */
export function createAdeWorkspaceSkill(params?: {
	appResourcesDir?: string;
	repoRoot?: string;
}): void {
	const contents = readAdeWorkspaceSkill(params);
	if (contents === null) {
		// Loud, not silent: a missing bundled skill means every agent loses the
		// `ade` usage reference, and a warning nobody reads is indistinguishable
		// from success (the exact failure mode the CLI launcher guards against).
		console.warn(
			"[agent-setup] Skipped ade-workspace skill: SKILL.md not found in resources or repo.",
		);
		return;
	}

	const target = getAdeWorkspaceSkillPath();
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const changed = writeFileIfChanged(target, contents, 0o644);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} ade-workspace skill → ${target}`,
	);
}
