/**
 * Phase 5 D1 — the host's `available_commands_update` cache.
 *
 * Written from `planning/PHASE_5_ACP_SLASH_PALETTE_DESIGN.md`, not from
 * `acp-session.ts`. The fact this file exists to defend is invisible from the
 * event stream: `session/new` does NOT return commands (design §Ground truth
 * 3), so the list arrives solely as a notification, and a pane that (re)mounts
 * after that notification fired has nothing to render unless the host kept it.
 * An empty palette and a dead subscription look identical, which is precisely
 * why the cache is asserted here rather than inferred from the UI.
 *
 * Doctrine of `config-read-back.test.ts` / `config-options.test.ts`: the fake
 * child is a REAL process seam. Every command list below is pushed as a
 * genuine `session/update` notification over NDJSON and comes back through the
 * real SDK and the real `mapSessionUpdate` — nothing about the wire is mocked.
 *
 * The wire-shape test loads the committed Phase 3 capture rather than a
 * transcription of it: a pasted copy would assert what I typed, and would keep
 * passing after the capture is re-recorded.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { AcpSession, type AcpSessionHandlers } from "./acp-session";
import { setAcpBinaryPathResolver } from "./binary-resolver";
import { FakeAcpChild } from "./fake-acp-child";
import type { AcpSessionUpdate } from "./types";

setAcpBinaryPathResolver(() => "/fake/claude-agent-acp/index.js");

const CWD = "/repo/phase-5";

type CommandsUpdate = Extract<
	AcpSessionUpdate,
	{ kind: "available_commands_update" }
>;

interface Rig {
	child: FakeAcpChild;
	session: AcpSession;
	updates: AcpSessionUpdate[];
	/** `info().availableCommands` sampled INSIDE each command re-emit. */
	atEmit: AvailableCommand[][];
}

let rig: Rig;

function makeRig(paneId = "pane-commands"): Rig {
	const child = new FakeAcpChild();
	const updates: AcpSessionUpdate[] = [];
	const atEmit: AvailableCommand[][] = [];
	let session: AcpSession | null = null;
	const handlers: AcpSessionHandlers = {
		onUpdate: (update) => {
			updates.push(update);
			if (update.kind === "available_commands_update" && session) {
				atEmit.push(session.info().availableCommands);
			}
		},
		onError: () => {},
		onExit: () => {},
	};
	session = new AcpSession(
		{ paneId, cwd: CWD, spawnProcess: child.spawnProcess },
		handlers,
	);
	return { child, session, updates, atEmit };
}

beforeEach(() => {
	rig = makeRig();
});

/** Spin until `count` command updates have been delivered, or time out. */
async function waitForCommandUpdates(count: number): Promise<void> {
	const deadline = Date.now() + 1000;
	while (
		rig.updates.filter((update) => update.kind === "available_commands_update")
			.length < count
	) {
		if (Date.now() > deadline) {
			throw new Error(`fewer than ${count} command updates within 1000ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** Push one real `available_commands_update` frame and wait for it to land. */
async function pushCommands(commands: AvailableCommand[]): Promise<void> {
	const already = rig.updates.filter(
		(update) => update.kind === "available_commands_update",
	).length;
	rig.child.sessionUpdate({
		sessionUpdate: "available_commands_update",
		availableCommands: commands,
	});
	await waitForCommandUpdates(already + 1);
}

function commandUpdates(): CommandsUpdate[] {
	return rig.updates.filter(
		(update): update is CommandsUpdate =>
			update.kind === "available_commands_update",
	);
}

function command(name: string, description = `${name} does a thing`) {
	return { name, description } satisfies AvailableCommand;
}

// =============================================================================
// The committed capture
// =============================================================================

/**
 * Walk up from this file until the capture turns up, rather than hardcoding a
 * `../` chain that would break on a directory move and — far worse — could
 * silently resolve to another file of the same name. Same resolver as
 * `AcpPane/transcript.phase3.test.ts`.
 */
function repoFile(relative: string): string {
	let dir = import.meta.dir;
	for (let up = 0; up < 20; up += 1) {
		const candidate = join(dir, relative);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`could not locate ${relative} above ${import.meta.dir}`);
}

const CAPTURE_PATH = "planning/spikes/acp-phase3-capture/frames.json";

/** The one real `available_commands_update` frame in the Phase 3 capture. */
function capturedCommands(): AvailableCommand[] {
	const raw: unknown = JSON.parse(readFileSync(repoFile(CAPTURE_PATH), "utf8"));
	if (!Array.isArray(raw)) throw new Error(`${CAPTURE_PATH} is not an array`);
	const frames = raw.filter(
		(frame): frame is { kind: string; commands: AvailableCommand[] } =>
			(frame as { kind?: unknown })?.kind === "available_commands_update",
	);
	if (frames.length !== 1) {
		throw new Error(
			`${CAPTURE_PATH} holds ${frames.length} command frames, expected 1`,
		);
	}
	return frames[0]?.commands ?? [];
}

describe("the captured command frame (population pin)", () => {
	const commands = capturedCommands();

	it("is the 103-command list the design cites, with the two named skills", () => {
		// Asserted BEFORE anything is measured against it. If the capture is
		// re-recorded against a different machine, every claim below is about a
		// different population and this is the test that says so.
		expect(commands).toHaveLength(103);
		const names = commands.map((entry) => entry.name);
		expect(names).toContain("wrap-up");
		expect(names).toContain("fable-orchestration");
	});

	it("carries the {name, description, input?} shape and nothing else", () => {
		const keys = new Set(commands.flatMap((entry) => Object.keys(entry)));
		expect([...keys].sort()).toEqual(["description", "input", "name"]);
		for (const entry of commands) {
			expect(typeof entry.name).toBe("string");
			expect(typeof entry.description).toBe("string");
		}
		// Some, not all, declare an argument hint — the D3 placeholder depends
		// on the optional half of that shape actually being optional.
		const withInput = commands.filter((entry) => entry.input);
		expect(withInput.length).toBeGreaterThan(0);
		expect(withInput.length).toBeLessThan(commands.length);
		for (const entry of withInput) {
			expect(typeof entry.input?.hint).toBe("string");
		}
	});
});

// =============================================================================
// D1 — the cache
// =============================================================================

describe("available_commands_update cache (D1)", () => {
	it("starts empty, before any notification has fired", async () => {
		await rig.session.start();

		// `session/new` returns sessionId/modes/configOptions only, so this is
		// the honest state a freshly-started pane seeds from.
		expect(rig.session.info().availableCommands).toEqual([]);
		expect(commandUpdates()).toHaveLength(0);

		await rig.session.dispose();
	});

	it("replaces the cache, and info() carries it", async () => {
		await rig.session.start();

		await pushCommands([command("wrap-up"), command("fable-orchestration")]);

		expect(
			rig.session.info().availableCommands.map((entry) => entry.name),
		).toEqual(["wrap-up", "fable-orchestration"]);

		await rig.session.dispose();
	});

	it("replaces wholesale — a later list does not merge with the earlier one", async () => {
		await rig.session.start();

		await pushCommands([command("wrap-up"), command("fable-orchestration")]);
		await pushCommands([command("fable-orchestration")]);

		// The disappearance case at the host level: a command absent from the
		// newest list is gone, not remembered. This is how a disabled skill
		// leaves the palette (design §Ground truth 5).
		expect(
			rig.session.info().availableCommands.map((entry) => entry.name),
		).toEqual(["fable-orchestration"]);

		await rig.session.dispose();
	});

	it("survives a second read, and hands out a copy each time", async () => {
		await rig.session.start();

		await pushCommands([command("wrap-up"), command("fable-orchestration")]);

		const first = rig.session.info().availableCommands;
		first.length = 0;
		first.push(command("mutated"));

		const second = rig.session.info().availableCommands;
		expect(second.map((entry) => entry.name)).toEqual([
			"wrap-up",
			"fable-orchestration",
		]);
		// A pane remount is a second read of the same cache; a caller that got
		// the live array could empty the palette for every pane by tidying its
		// own copy.
		expect(second).not.toBe(first);

		await rig.session.dispose();
	});

	it("empties the cache on an empty update", async () => {
		await rig.session.start();

		await pushCommands([command("wrap-up")]);
		expect(rig.session.info().availableCommands).toHaveLength(1);

		await pushCommands([]);

		// An empty list is a real state the adapter can report, and it must not
		// be treated as "no news" — the renderer's D4 message depends on it.
		expect(rig.session.info().availableCommands).toEqual([]);

		await rig.session.dispose();
	});

	it("replaces the cache BEFORE re-emitting the update", async () => {
		await rig.session.start();

		await pushCommands([command("wrap-up")]);
		await pushCommands([command("fable-orchestration")]);

		// The renderer reacts to the event by reading `acp.state`; if the cache
		// were written after the emit, that read would return the PREVIOUS
		// list and the palette would sit one update behind for good.
		expect(rig.atEmit.map((list) => list.map((entry) => entry.name))).toEqual([
			["wrap-up"],
			["fable-orchestration"],
		]);

		await rig.session.dispose();
	});
});

// =============================================================================
// Wire shape — the real capture through the real seam
// =============================================================================

describe("the captured frame crosses mapSessionUpdate intact", () => {
	it("re-emits and caches all 103 commands byte-for-byte", async () => {
		const commands = capturedCommands();
		await rig.session.start();

		await pushCommands(commands);

		const emitted = commandUpdates()[0];
		expect(emitted?.commands).toHaveLength(103);
		// Deep-equal against the file, not a spot check: a mapper that dropped
		// `input`, stringified a description or reordered the list would still
		// produce 103 plausible-looking commands.
		expect(emitted?.commands).toEqual(commands);
		expect(rig.session.info().availableCommands).toEqual(commands);

		const dataviz = rig.session
			.info()
			.availableCommands.find((entry) => entry.name === "dataviz");
		// The >1 KB description the design warns about, uncut at this layer:
		// truncation is the renderer's job (D3), and a host that shortened it
		// would hide how bad the real payload is.
		expect(dataviz?.description.length).toBeGreaterThan(1000);

		await rig.session.dispose();
	});
});

// =============================================================================
// A5/F8 — info() deep-copies the cached commands
// =============================================================================

describe("info() hands out commands nobody else can mutate (A5/F8)", () => {
	it("does not alias the cached command objects", async () => {
		await rig.session.start();

		await pushCommands([command("wrap-up", "roll up the session")]);

		// The array was already copied; the ELEMENTS were not, so a caller
		// tidying its own copy rewrote the host's cache for every pane. The
		// `ConfigOptionCache.list()` precedent copies a level deeper.
		const first = rig.session.info().availableCommands;
		const entry = first[0];
		if (!entry) throw new Error("no command came back");
		entry.name = "mutated";
		entry.description = "mutated";

		const second = rig.session.info().availableCommands;
		expect(second[0]?.name).toBe("wrap-up");
		expect(second[0]?.description).toBe("roll up the session");
		expect(second[0]).not.toBe(entry);

		await rig.session.dispose();
	});

	it("does not alias the nested input hint", async () => {
		await rig.session.start();

		await pushCommands([
			{
				name: "storm-research",
				description: "run the pipeline",
				input: { hint: "topic" },
			},
		]);

		const first = rig.session.info().availableCommands;
		const input = first[0]?.input;
		if (!input) throw new Error("no input came back");
		input.hint = "mutated";

		expect(rig.session.info().availableCommands[0]?.input?.hint).toBe("topic");

		await rig.session.dispose();
	});

	it("leaves a command without input still without input", async () => {
		await rig.session.start();

		await pushCommands([command("wrap-up")]);

		// A copy that manufactured `input: undefined` would change the shape
		// the wire-equality test above asserts.
		const entry = rig.session.info().availableCommands[0];
		expect(entry && "input" in entry ? entry.input : null).toBeFalsy();
		expect(rig.session.info().availableCommands).toEqual([command("wrap-up")]);

		await rig.session.dispose();
	});
});
