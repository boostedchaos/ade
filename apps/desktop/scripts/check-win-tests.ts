/**
 * Windows test ratchet: run the FULL desktop suite and compare failures
 * against scripts/win-test-baseline.txt (the known-failing set on Windows —
 * mostly tests that assert macOS behavior, plus upstream rename drift).
 *
 * bun test has no exclude flag, so instead of an allow-list that silently
 * skips new code, everything runs and only NEW failures fail the check.
 * Tests that start passing are reported so the baseline can be pruned.
 *
 * Update the baseline by pasting the "new failures" lines it prints (or
 * regenerate: bun test 2>&1 | grep "^(fail)" | sed "s/ \[[0-9.]*ms\]$//" | sort -u).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "..");
const baselinePath = join(import.meta.dir, "win-test-baseline.txt");

const normalize = (line: string) => line.replace(/ \[[0-9.]+ms\]$/, "").trim();

const baseline = new Set(
	readFileSync(baselinePath, "utf8")
		.split("\n")
		.map(normalize)
		.filter(Boolean),
);

const proc = Bun.spawnSync(["bun", "test", "--timeout", "20000"], {
	cwd: desktopRoot,
	stdout: "pipe",
	stderr: "pipe",
	// The step-level CI timeout is the real guard; this is local insurance.
	timeout: 15 * 60 * 1000,
});

const output = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;

const summary = output.match(/Ran (\d+) tests across (\d+) files/);
if (!summary) {
	console.error(output.slice(-4000));
	console.error(
		"\nRATCHET: suite did not produce a summary line — it crashed or hung. Failing.",
	);
	process.exit(1);
}

const failures = new Set(
	output
		.split("\n")
		.filter((l) => l.startsWith("(fail)"))
		.map(normalize),
);

const newFailures = [...failures].filter((f) => !baseline.has(f)).sort();
const fixed = [...baseline].filter((f) => !failures.has(f)).sort();

console.log(
	`RATCHET: ${summary[0]}; ${failures.size} failing (baseline ${baseline.size}).`,
);
if (fixed.length > 0) {
	console.log(
		`\n${fixed.length} baseline test(s) now PASS — prune them from scripts/win-test-baseline.txt:`,
	);
	for (const f of fixed) console.log(`  ${f}`);
}
if (newFailures.length > 0) {
	console.error(`\n${newFailures.length} NEW failure(s) not in the baseline:`);
	for (const f of newFailures) console.error(`  ${f}`);
	console.error(
		"\nFix the regression, or if the failure is expected on Windows, add the line(s) to scripts/win-test-baseline.txt.",
	);
	process.exit(1);
}
console.log("RATCHET: no new failures.");
