import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Behavioral tests for the create-from-existing persona duplication
 * (issue #41, agent-duplicate.ts). Uses a throwaway ADE_HOME_DIR (set
 * BEFORE any module that reads it is imported) and real scaffolded agents in
 * temp dirs — same pattern as agent-scaffold.test.ts. No DB, no git: the
 * scaffold is given a pre-made worktree dir (the external-worktree path).
 */

const TEST_HOME = join(
	tmpdir(),
	`ade-duplicate-test-${process.pid}-${Date.now()}`,
);
process.env.ADE_HOME_DIR = TEST_HOME;

let getAgentHome: (id: string) => string;
let getAgentMemoryDir: (id: string) => string;
let scaffoldAgentMemory: typeof import("./agent-scaffold").scaffoldAgentMemory;
let duplicateAgentPersona: typeof import("./agent-duplicate").duplicateAgentPersona;
let restampPersonaContent: typeof import("./agent-duplicate").restampPersonaContent;
let extractLessonsSection: typeof import("./agent-duplicate").extractLessonsSection;
let replaceLessonsSection: typeof import("./agent-duplicate").replaceLessonsSection;

beforeAll(async () => {
	const home = await import("./agent-home");
	getAgentHome = home.getAgentHome;
	getAgentMemoryDir = home.getAgentMemoryDir;
	scaffoldAgentMemory = (await import("./agent-scaffold")).scaffoldAgentMemory;
	const dup = await import("./agent-duplicate");
	duplicateAgentPersona = dup.duplicateAgentPersona;
	restampPersonaContent = dup.restampPersonaContent;
	extractLessonsSection = dup.extractLessonsSection;
	replaceLessonsSection = dup.replaceLessonsSection;
	expect(getAgentHome("x").startsWith(TEST_HOME)).toBe(true);
});

afterAll(() => {
	rmSync(TEST_HOME, { recursive: true, force: true });
});

/** Scaffold an agent without git/DB: pre-make the worktree dir and scaffold. */
function makeScaffoldedAgent(agentId: string, agentName: string, role?: string) {
	const worktree = join(getAgentHome(agentId), "worktree");
	mkdirSync(worktree, { recursive: true });
	scaffoldAgentMemory({
		agentId,
		agentName,
		runtime: "claude",
		userName: "Cameron",
		role,
		worktreePath: worktree,
	});
}

describe("restampPersonaContent", () => {
	const src = {
		agentId: "src-1111",
		agentName: "Documenter",
		agentHome: "C:\\home\\agents\\src-1111",
	};
	const tgt = {
		agentId: "tgt-2222",
		agentName: "DocBuilder",
		agentHome: "C:\\home\\agents\\tgt-2222",
	};

	it("replaces the home path in native and forward-slash forms", () => {
		const out = restampPersonaContent(
			"work in C:\\home\\agents\\src-1111\\worktree and C:/home/agents/src-1111/skills",
			src,
			tgt,
		);
		expect(out).toContain("C:\\home\\agents\\tgt-2222\\worktree");
		expect(out).toContain("C:/home/agents/tgt-2222/skills");
		expect(out).not.toContain("src-1111");
	});

	it("replaces the bare agent id and the name at word boundaries", () => {
		const out = restampPersonaContent(
			"You are Documenter (id src-1111). Documenter's notes. Documenters stay.",
			src,
			tgt,
		);
		expect(out).toContain("You are DocBuilder (id tgt-2222)");
		expect(out).toContain("DocBuilder's notes");
		// A longer word containing the name is NOT mangled.
		expect(out).toContain("Documenters stay");
	});

	it("is a no-op when identities are equal", () => {
		const text = "You are Documenter at C:\\home\\agents\\src-1111";
		expect(restampPersonaContent(text, src, src)).toBe(text);
	});
});

describe("Lessons section helpers", () => {
	const memory = [
		"# Memory — Documenter",
		"",
		"## Environment",
		"- Agent home: /x",
		"",
		"## Lessons",
		"- bun on Windows cannot load better-sqlite3",
		"- prefer rg over grep",
		"",
		"## Detail files",
		"- (none)",
	].join("\n");

	it("extracts the Lessons body without the heading, stopping at the next section", () => {
		const lessons = extractLessonsSection(memory);
		expect(lessons).toContain("better-sqlite3");
		expect(lessons).toContain("prefer rg over grep");
		expect(lessons).not.toContain("## Lessons");
		expect(lessons).not.toContain("Detail files");
	});

	it("returns null when there is no Lessons section", () => {
		expect(extractLessonsSection("# Memory\n\n## Environment\n- x\n")).toBeNull();
	});

	it("replaces an existing Lessons body and preserves surrounding sections", () => {
		const out = replaceLessonsSection(memory, "- carried lesson\n");
		expect(out).toContain("## Environment");
		expect(out).toContain("- carried lesson");
		expect(out).toContain("## Detail files");
		expect(out).not.toContain("prefer rg over grep");
		// Section order intact: Environment before Lessons before Detail files.
		expect(out.indexOf("## Environment")).toBeLessThan(out.indexOf("## Lessons"));
		expect(out.indexOf("## Lessons")).toBeLessThan(out.indexOf("## Detail files"));
	});

	it("appends a Lessons section when none exists", () => {
		const out = replaceLessonsSection("# Memory\n\n## Environment\n- x\n", "- new\n");
		expect(out).toContain("## Lessons");
		expect(out).toContain("- new");
	});
});

describe("duplicateAgentPersona — end to end over real scaffolds", () => {
	const SRC = "dup-source";
	const TGT = "dup-target";
	let srcMem: string;
	let tgtMem: string;
	let srcAgentMdBefore: string;
	let srcMemoryMdBefore: string;

	beforeAll(() => {
		makeScaffoldedAgent(SRC, "Documenter", "Writes and maintains project docs.");
		srcMem = getAgentMemoryDir(SRC);

		// Tune the source persona the way a real agent would over time.
		const tunedAgentMd = [
			`# Documenter`,
			"",
			`You are Documenter, an autonomous coding agent working in a dedicated git`,
			`worktree.`,
			"",
			"## Role",
			"- Writes and maintains project docs; owns the changelog.",
			"",
			"## Operating brief",
			`- Work only within your worktree: ${getAgentHome(SRC)}/worktree`,
			`- Reusable procedures become skills under ${getAgentHome(SRC)}/skills/, not memory notes.`,
			"",
			"## Standing preferences",
			"- Use sentence case for headings.",
			"- Never use emojis in docs.",
			"",
		].join("\n");
		writeFileSync(join(srcMem, "AGENT.md"), tunedAgentMd, "utf8");
		writeFileSync(
			join(srcMem, "USER.md"),
			"# User profile\n\n- Name: Cameron\n- Timezone: America/New_York\n",
			"utf8",
		);
		// A tuned skill referencing the source agent's home.
		const skillDir = join(getAgentHome(SRC), "skills", "changelog-pass");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: changelog-pass\ndescription: Update the changelog.\n---\n\nRun from ${getAgentHome(SRC)}/worktree. Documenter owns this.\n`,
			"utf8",
		);
		// Lessons + project notes in MEMORY.md.
		const memoryPath = join(srcMem, "MEMORY.md");
		writeFileSync(
			memoryPath,
			readFileSync(memoryPath, "utf8")
				.replace(
					"- (conventions, build/test commands, architecture notes — learned over time)",
					"- LLT repo builds with `bun run build` (SOURCE-PROJECT-FACT)",
				)
				.replace(
					"- (tool quirks, workarounds, corrections that shouldn't repeat)",
					"- rg needs --no-ignore in generated dirs (PORTABLE-LESSON)",
				),
			"utf8",
		);
		// A project-bound topic file that must NOT be copied.
		mkdirSync(join(srcMem, "memories"), { recursive: true });
		writeFileSync(join(srcMem, "memories", "llt-arch.md"), "LLT only\n", "utf8");

		srcAgentMdBefore = readFileSync(join(srcMem, "AGENT.md"), "utf8");
		srcMemoryMdBefore = readFileSync(join(srcMem, "MEMORY.md"), "utf8");

		// Fresh target in "another team" (teams are DB rows; on disk the flow
		// is identical), scaffolded first — copy-after-scaffold ordering.
		makeScaffoldedAgent(TGT, "DocBuilder");
		tgtMem = getAgentMemoryDir(TGT);

		duplicateAgentPersona({
			source: { agentId: SRC, agentName: "Documenter" },
			target: { agentId: TGT, agentName: "DocBuilder" },
		});
	});

	it("carries the tuned Role and Standing preferences into the target AGENT.md", () => {
		const agentMd = readFileSync(join(tgtMem, "AGENT.md"), "utf8");
		expect(agentMd).toContain("owns the changelog");
		expect(agentMd).toContain("Use sentence case for headings.");
		expect(agentMd).toContain("Never use emojis in docs.");
	});

	it("re-stamps identity and home paths to the NEW agent", () => {
		const agentMd = readFileSync(join(tgtMem, "AGENT.md"), "utf8");
		expect(agentMd).toContain("# DocBuilder");
		expect(agentMd).toContain("You are DocBuilder");
		const tgtHomeNorm = getAgentHome(TGT).replaceAll("\\", "/");
		expect(agentMd.replaceAll("\\", "/")).toContain(`${tgtHomeNorm}/worktree`);
		expect(agentMd).not.toContain("Documenter");
		expect(agentMd).not.toContain(SRC);
	});

	it("copies USER.md verbatim (agent-independent)", () => {
		expect(readFileSync(join(tgtMem, "USER.md"), "utf8")).toContain(
			"Timezone: America/New_York",
		);
	});

	it("copies skills, re-stamped for the new agent", () => {
		const skillPath = join(
			getAgentHome(TGT),
			"skills",
			"changelog-pass",
			"SKILL.md",
		);
		expect(existsSync(skillPath)).toBe(true);
		const skill = readFileSync(skillPath, "utf8");
		expect(skill).toContain("DocBuilder owns this.");
		expect(skill.replaceAll("\\", "/")).toContain(
			`${getAgentHome(TGT).replaceAll("\\", "/")}/worktree`,
		);
		expect(skill).not.toContain(SRC);
	});

	it("does NOT copy MEMORY.md project facts or memories/ topic files", () => {
		const memoryMd = readFileSync(join(tgtMem, "MEMORY.md"), "utf8");
		expect(memoryMd).toContain("# Memory — DocBuilder");
		expect(memoryMd).not.toContain("SOURCE-PROJECT-FACT");
		expect(memoryMd).not.toContain("PORTABLE-LESSON"); // lessons not toggled
		expect(existsSync(join(tgtMem, "memories", "llt-arch.md"))).toBe(false);
	});

	it("regenerates (not copies) the write-back protocol for the target", () => {
		const proto = readFileSync(
			join(tgtMem, ".writeback-protocol.md"),
			"utf8",
		);
		expect(proto).toContain(getAgentHome(TGT));
		expect(proto).not.toContain(getAgentHome(SRC));
	});

	it("leaves the source agent untouched", () => {
		expect(readFileSync(join(srcMem, "AGENT.md"), "utf8")).toBe(
			srcAgentMdBefore,
		);
		expect(readFileSync(join(srcMem, "MEMORY.md"), "utf8")).toBe(
			srcMemoryMdBefore,
		);
		expect(existsSync(join(srcMem, "memories", "llt-arch.md"))).toBe(true);
	});

	it("carries the Lessons section iff toggled, into an otherwise-fresh MEMORY.md", () => {
		const TGT2 = "dup-target-lessons";
		makeScaffoldedAgent(TGT2, "DocBuilder2");
		const result = duplicateAgentPersona({
			source: { agentId: SRC, agentName: "Documenter" },
			target: { agentId: TGT2, agentName: "DocBuilder2" },
			includeLessons: true,
		});
		expect(result.lessonsCarried).toBe(true);
		const memoryMd = readFileSync(
			join(getAgentMemoryDir(TGT2), "MEMORY.md"),
			"utf8",
		);
		expect(memoryMd).toContain("PORTABLE-LESSON");
		expect(memoryMd).not.toContain("SOURCE-PROJECT-FACT");
		expect(memoryMd).toContain("# Memory — DocBuilder2");
		// The fresh Environment section survives the section splice.
		expect(memoryMd).toContain(getAgentHome(TGT2));
	});

	it("tolerates a source with no scaffolded persona (copies nothing, no throw)", () => {
		const BARE = "dup-bare-source";
		mkdirSync(getAgentHome(BARE), { recursive: true }); // no memory/, no skills/
		const TGT3 = "dup-target-bare";
		makeScaffoldedAgent(TGT3, "Fresh");
		const result = duplicateAgentPersona({
			source: { agentId: BARE, agentName: "Bare" },
			target: { agentId: TGT3, agentName: "Fresh" },
			includeLessons: true,
		});
		expect(result.copied).toEqual([]);
		expect(result.lessonsCarried).toBe(false);
		// Target keeps its fresh scaffold templates.
		expect(
			readFileSync(join(getAgentMemoryDir(TGT3), "AGENT.md"), "utf8"),
		).toContain("You are Fresh");
	});
});
