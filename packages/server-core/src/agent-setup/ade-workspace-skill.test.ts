import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ADE_WORKSPACE_SKILL_NAME,
	adeWorkspaceSkillCandidates,
	findSkillsRepoRoot,
	readAdeWorkspaceSkill,
	resolveAdeWorkspaceSkillSource,
} from "./ade-workspace-skill";

describe("adeWorkspaceSkillCandidates", () => {
	it("prefers a packaged resources copy over the repo checkout", () => {
		const candidates = adeWorkspaceSkillCandidates({
			appResourcesDir: "/res",
			repoRoot: "/repo",
		});
		expect(candidates).toEqual([
			join("/res", "skills", ADE_WORKSPACE_SKILL_NAME, "SKILL.md"),
			join("/repo", "skills", ADE_WORKSPACE_SKILL_NAME, "SKILL.md"),
		]);
	});

	it("returns nothing when neither location is known", () => {
		expect(adeWorkspaceSkillCandidates({})).toEqual([]);
	});
});

describe("resolveAdeWorkspaceSkillSource", () => {
	it("picks the first candidate that exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "ade-skill-"));
		const real = join(dir, "SKILL.md");
		writeFileSync(real, "# hi", "utf8");
		expect(
			resolveAdeWorkspaceSkillSource([join(dir, "missing.md"), real]),
		).toBe(real);
	});

	it("returns null when nothing exists", () => {
		expect(resolveAdeWorkspaceSkillSource(["/nope/SKILL.md"])).toBeNull();
	});
});

describe("findSkillsRepoRoot", () => {
	it("walks up to the directory holding skills/ade-workspace/SKILL.md", () => {
		const root = mkdtempSync(join(tmpdir(), "ade-skill-root-"));
		const skillDir = join(root, "skills", ADE_WORKSPACE_SKILL_NAME);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "# hi", "utf8");
		const deep = join(root, "packages", "server-core", "src");
		mkdirSync(deep, { recursive: true });
		expect(findSkillsRepoRoot(deep)).toBe(root);
	});

	it("returns undefined when there is no such root above it", () => {
		expect(findSkillsRepoRoot(tmpdir())).toBeUndefined();
	});
});

describe("readAdeWorkspaceSkill", () => {
	it("returns null rather than throwing when the skill is missing", () => {
		expect(
			readAdeWorkspaceSkill({ appResourcesDir: "/nope", repoRoot: "/nope" }),
		).toBeNull();
	});

	/**
	 * Reads THE REAL bundled file, not a fixture: the point of resolving the
	 * skill from disk instead of a TypeScript constant is that there is one copy,
	 * and a test against a fixture would pass while the shipped document rotted.
	 */
	it("normalizes a UTF-8 BOM, CRLF, and a lone CR to a bare LF frontmatter", () => {
		// A checkout/unzip on Windows can prepend a BOM and use CRLF (or a stray
		// lone CR); the frontmatter must still start at a bare "---\n" for the
		// agentskills.io parser, and no CR may survive anywhere in the body.
		const root = mkdtempSync(join(tmpdir(), "ade-skill-eol-"));
		const skillDir = join(root, "skills", ADE_WORKSPACE_SKILL_NAME);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"﻿---\r\nname: x\rdescription: y\r\n---\r\nbody\r\n",
			"utf8",
		);
		const text = readAdeWorkspaceSkill({ repoRoot: root }) ?? "";
		expect(text.startsWith("---\n")).toBe(true);
		expect(text).not.toContain("\r");
		expect(text).not.toContain("﻿");
		expect(text).toBe("---\nname: x\ndescription: y\n---\nbody\n");
	});

	it("reads the bundled skill and it is a usable agentskills.io document", () => {
		const contents = readAdeWorkspaceSkill();
		expect(contents).not.toBeNull();
		const text = contents ?? "";
		expect(text.startsWith("---\n")).toBe(true);
		expect(text).toContain(`name: ${ADE_WORKSPACE_SKILL_NAME}`);
		expect(text).toContain("description:");
		// The flagship example the SPEC and the bridge test both pin.
		expect(text).toContain(
			"ade new-pane --type browser --direction right --url https://localhost:3000 --focus false",
		);
	});
});
