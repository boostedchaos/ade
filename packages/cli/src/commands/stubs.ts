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

const STUBS: StubSpec[] = [
	{
		name: "cli",
		group: "Not yet implemented",
		summary: "Manage the ade bin itself (cli install — put `ade` on PATH)",
		phase: "Phase 5 — parity extras",
	},
];

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
