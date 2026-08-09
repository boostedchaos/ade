/**
 * Golden tests driven by the ACTUAL captured probe log.
 *
 * The whole point of Phase 0 was to capture what Claude Code 2.1.226 really
 * emits, so these replay that log verbatim rather than a paraphrase of it. A
 * hand-written argv list would keep passing after the contract was re-captured
 * against a newer Claude Code; this fails loudly instead.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAde } from "./fake-ade";
import { parseGlobal } from "./parse";
import { type ProbeCall, parseProbeLog, parsePythonList } from "./probe-log";
import { CompatStore } from "./store";
import { runTmuxCompat } from "./translate";

const LOG_PATH = join(
	import.meta.dir,
	"../../../../docs/specs/mission-control/probe/tmux-calls.log",
);

// The probe log is a Phase-0 capture that lives on the machine that ran the
// probe; it is not committed (and is absent on Windows CI, which has no /bin/sh
// to have run it). Skip the whole golden suite when it is missing rather than
// erroring — a fresh clone or a Windows box has nothing to replay.
const HAS_LOG = existsSync(LOG_PATH);

const LEADER_ADE_PANE = "ade-leader";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ade-tmux-golden-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface Replay {
	exitCodes: number[];
	stdout: string[][];
	stderr: string[][];
	ade: FakeAde;
}

async function replay(calls: ProbeCall[], storeDir: string): Promise<Replay> {
	const ade = new FakeAde(LEADER_ADE_PANE, "tab-0");
	const out: Replay = { exitCodes: [], stdout: [], stderr: [], ade };

	for (const call of calls) {
		const stdout: string[] = [];
		const stderr: string[] = [];
		const code = await runTmuxCompat(call.argv, {
			store: new CompatStore(storeDir),
			io: {
				stdout: (text) => stdout.push(text),
				stderr: (text) => stderr.push(text),
			},
			env: {
				TMUX_PANE: "%0",
				TMUX: "/fake-socket,0,0",
				ADE_SURFACE_ID: LEADER_ADE_PANE,
				ADE_TMUX_COMPAT_DIR: storeDir,
			},
			cwd: call.cwd,
			connect: async () => ade,
		});
		out.exitCodes.push(code);
		out.stdout.push(stdout);
		out.stderr.push(stderr);
	}
	return out;
}

/** stdout of the call whose argv ends with these tokens, first match. */
function stdoutFor(
	calls: ProbeCall[],
	replayed: Replay,
	predicate: (argv: string[]) => boolean,
): string[] {
	const index = calls.findIndex((call) => predicate(call.argv));
	if (index === -1) throw new Error("no matching probe call");
	return replayed.stdout[index] as string[];
}

describe.skipIf(!HAS_LOG)("probe log fixture", () => {
	it("parses python reprs including escapes", () => {
		expect(parsePythonList("['a', 'b']")).toEqual(["a", "b"]);
		expect(parsePythonList("[\"it's\", 'x']")).toEqual(["it's", "x"]);
		expect(parsePythonList("['a\\\\b']")).toEqual(["a\\b"]);
		expect(parsePythonList("[]")).toEqual([]);
	});

	// Guards against the fixture moving, emptying, or losing a run: a golden
	// suite whose input silently became [] would report all green.
	it("still holds both captured runs", () => {
		const calls = parseProbeLog(LOG_PATH);
		expect(calls.length).toBeGreaterThanOrEqual(28);
		const runs = new Set(calls.map((c) => c.run));
		expect(runs.size).toBe(2);
		for (const run of runs) expect(run).toMatch(/^RUN [AB]/);
	});

	it("covers every verb the shim claims to implement for teammates", () => {
		const verbs = new Set(
			parseProbeLog(LOG_PATH).map((call) => parseGlobal(call.argv).verb),
		);
		for (const verb of [
			"display-message",
			"list-panes",
			"split-window",
			"set-option",
			"select-pane",
			"respawn-pane",
			"kill-pane",
			"has-session",
			"new-session",
		]) {
			expect([...verbs]).toContain(verb);
		}
	});
});

describe.skipIf(!HAS_LOG)("RUN A — leader inside tmux", () => {
	const calls = HAS_LOG
		? parseProbeLog(LOG_PATH).filter((c) => c.run.startsWith("RUN A"))
		: [];

	it("replays end to end with every call exiting 0", async () => {
		const result = await replay(calls, dir);
		for (const [index, code] of result.exitCodes.entries()) {
			if (code !== 0) {
				throw new Error(
					`call ${index} (${calls[index]?.argv.join(" ")}) exited ${code}: ${result.stderr[index]?.join(" ")}`,
				);
			}
		}
	});

	it("answers the four format strings exactly", async () => {
		const result = await replay(calls, dir);

		expect(
			stdoutFor(calls, result, (argv) =>
				argv.includes("#{session_name}:#{window_id}.#{pane_id}"),
			),
		).toEqual(["ade:@0.%0"]);

		expect(
			stdoutFor(calls, result, (argv) => argv.includes("#{window_id}")),
		).toEqual(["@0"]);

		// First list-panes: only the leader exists.
		expect(
			stdoutFor(calls, result, (argv) => argv.includes("list-panes")),
		).toEqual(["%0"]);

		// split-window -P -F '#{pane_id}' allocates the next id.
		expect(
			stdoutFor(calls, result, (argv) => argv.includes("split-window")),
		).toEqual(["%1"]);
	});

	it("re-lists both panes after the split", async () => {
		const result = await replay(calls, dir);
		const listings = calls
			.map((call, index) => ({ call, index }))
			.filter(({ call }) => call.argv.includes("list-panes"))
			.map(({ index }) => result.stdout[index]);
		expect(listings.length).toBe(2);
		expect(listings[0]).toEqual(["%0"]);
		expect(listings[1]).toEqual(["%0\n%1"]);
	});

	it("makes exactly the control-plane calls the flow needs", async () => {
		const result = await replay(calls, dir);
		const cmds = result.ade.calls.map((c) => c.cmd);
		// One split, one pane close, and the respawn's send. No polling, no
		// capture-pane, no send-key — matching PROBE-CONTRACT §4 and §5.5.
		expect(cmds.filter((c) => c === "new-pane").length).toBe(1);
		expect(cmds.filter((c) => c === "send").length).toBe(1);
		expect(cmds.filter((c) => c === "close-pane").length).toBe(1);
		expect(cmds).not.toContain("send-key");
		expect(cmds).not.toContain("capture-pane");
	});

	it("respawns by exec'ing the verbatim teammate command in the new pane", async () => {
		const result = await replay(calls, dir);
		const respawn = calls.find((c) => c.argv.includes("respawn-pane"));
		const command = respawn?.argv[respawn.argv.length - 1] as string;
		expect(command).toContain("--agent-id helper@session-");

		const send = result.ade.calls.find((c) => c.cmd === "send");
		expect(send?.args.enter).toBe(true);
		expect(send?.args.pane).toBe("pane-1");
		expect(send?.args.text).toBe(`exec /bin/sh -c '${command}'`);
	});

	it("does not steal focus while titling teammate panes", async () => {
		const result = await replay(calls, dir);
		// select-pane -T sets the title only; focus stays where Kyle left it.
		expect(result.ade.calls.map((c) => c.cmd)).not.toContain("focus-pane");
		expect(result.ade.focusedPane).toBe(LEADER_ADE_PANE);
	});

	it("closes the teammate's ADE pane on teardown", async () => {
		const result = await replay(calls, dir);
		const close = result.ade.calls.find((c) => c.cmd === "close-pane");
		expect(close?.args.pane).toBe("pane-1");
		expect(result.ade.tabs.get("tab-0")).toEqual([LEADER_ADE_PANE]);
		// And the mapping is gone, so a later %1 cannot hit a recycled pane.
		expect(new CompatStore(dir).read().panes["%1"]).toBeUndefined();
	});
});

describe.skipIf(!HAS_LOG)("RUN B — leader outside tmux (external swarm session)", () => {
	const calls = HAS_LOG
		? parseProbeLog(LOG_PATH).filter((c) => c.run.startsWith("RUN B"))
		: [];

	it("reports tmux available and the session absent, then creates it", async () => {
		const result = await replay(calls, dir);

		const versionIndex = calls.findIndex((c) => c.argv[0] === "-V");
		expect(result.exitCodes[versionIndex]).toBe(0);
		expect(result.stdout[versionIndex]).toEqual(["tmux 3.4"]);

		// has-session MUST exit non-zero or Claude skips new-session entirely
		// (PROBE-CONTRACT §6.5).
		const hasIndex = calls.findIndex((c) => c.argv.includes("has-session"));
		expect(result.exitCodes[hasIndex]).toBe(1);

		const newIndex = calls.findIndex((c) => c.argv.includes("new-session"));
		expect(result.exitCodes[newIndex]).toBe(0);
		expect(result.stdout[newIndex]).toEqual(["%1"]);
	});

	it("replays the rest with every call exiting 0", async () => {
		const result = await replay(calls, dir);
		for (const [index, code] of result.exitCodes.entries()) {
			if (calls[index]?.argv.includes("has-session")) continue;
			if (code !== 0) {
				throw new Error(
					`call ${index} (${calls[index]?.argv.join(" ")}) exited ${code}: ${result.stderr[index]?.join(" ")}`,
				);
			}
		}
	});

	it("puts the swarm in a tab of its own, unfocused", async () => {
		const result = await replay(calls, dir);
		const newTabs = result.ade.calls.filter((c) => c.cmd === "new-tab");
		expect(newTabs.length).toBe(1);
		expect(newTabs[0]?.args.focus).toBe(false);
		expect(result.ade.focusedPane).toBe(LEADER_ADE_PANE);
		// The swarm pane never joined the leader's tab; teardown then emptied
		// (and so removed) the swarm tab, leaving the leader's tab untouched.
		expect([...result.ade.tabs.keys()]).toEqual(["tab-0"]);
		expect(result.ade.tabs.get("tab-0")).toEqual([LEADER_ADE_PANE]);
	});

	it("resolves session:window targets to that tab's panes", async () => {
		const result = await replay(calls, dir);
		const listings = calls
			.map((call, index) => ({ call, index }))
			.filter(({ call }) => call.argv.includes("list-panes"))
			.map(({ index }) => result.stdout[index]);
		expect(listings.length).toBe(2);
		for (const listing of listings) expect(listing).toEqual(["%1"]);
	});

	it("sends the teammate command into the swarm pane, then kills it", async () => {
		const result = await replay(calls, dir);
		const send = result.ade.calls.find((c) => c.cmd === "send");
		expect(send?.args.pane).toBe("pane-1");
		expect(String(send?.args.text)).toStartWith("exec /bin/sh -c 'cd ");
		const close = result.ade.calls.find((c) => c.cmd === "close-pane");
		expect(close?.args.pane).toBe("pane-1");
	});

	it("accepts -L socket flags without treating them as a verb", async () => {
		// Every RUN B call carries `-L claude-swarm-87807`; a parser that let the
		// socket flag through would dispatch on the wrong token.
		expect(
			calls.filter((c) => c.argv[0] === "-L").length,
		).toBeGreaterThanOrEqual(10);
		const result = await replay(calls, dir);
		const unexpected = result.stderr
			.map((lines, index) => ({ lines, argv: calls[index]?.argv ?? [] }))
			// has-session's "can't find session" is the correct answer, not a
			// resolution failure.
			.filter(({ argv }) => !argv.includes("has-session"))
			.flatMap(({ lines }) => lines);
		expect(unexpected).toEqual([]);
	});
});
