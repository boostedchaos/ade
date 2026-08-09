/**
 * Placeholders for command groups later phases fill in. They exist now so the
 * dispatch table, `ade --help`, and the exit-code contract are stable: calling
 * one prints "not yet implemented" and exits 2 (unsupported), never 0.
 */
import type { Command } from "../command";

interface StubSpec {
	name: string;
	group: string;
	summary: string;
	phase: string;
}

/**
 * Empty since `cli` shipped (Phase 5 — parity extras). Kept, rather than
 * deleted, because the dispatch/help/exit-code machinery around stubs is what
 * makes the next unbuilt command declarable in one line — and run.test.ts
 * derives its coverage from this list rather than a hand-kept copy.
 */
const STUBS: StubSpec[] = [];

export const stubCommands: Command[] = STUBS.map((stub) => ({
	name: stub.name,
	group: stub.group,
	summary: stub.summary,
	kind: "stub" as const,
	rawArgs: true,
	notes: `Not yet implemented — lands in ${stub.phase}.`,
}));

export const stubPhase = (name: string): string | undefined =>
	STUBS.find((s) => s.name === name)?.phase;
