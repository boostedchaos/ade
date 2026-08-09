/**
 * Unit tests for translator paths the probe did not enter — the ones
 * PROBE-CONTRACT §2.5 warns are reachable but uncaptured, plus the failure
 * modes the shim has to get right (re-respawn, honest has-session, fail-soft
 * unknown verbs).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAde } from "./fake-ade";
import { CompatStore, LOG_FILENAME } from "./store";
import { type ControlApi, runTmuxCompat, TMUX_VERSION } from "./translate";

const LEADER = "ade-leader";

let dir: string;
let ade: FakeAde;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ade-tmux-unit-"));
	ade = new FakeAde(LEADER, "tab-0");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
	code: number;
	out: string[];
	err: string[];
}

async function tmux(
	argv: string[],
	options: { api?: ControlApi; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runTmuxCompat(argv, {
		store: new CompatStore(dir),
		io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
		env: {
			TMUX_PANE: "%0",
			ADE_SURFACE_ID: LEADER,
			ADE_TMUX_COMPAT_DIR: dir,
			...options.env,
		},
		cwd: "/work",
		connect: async () => options.api ?? ade,
	});
	return { code, out, err };
}

const cmds = () => ade.calls.map((c) => c.cmd);

describe("startup detection", () => {
	it("reports a version and exits 0 without touching the socket", async () => {
		const result = await tmux(["-V"]);
		expect(result.code).toBe(0);
		expect(result.out).toEqual([TMUX_VERSION]);
		expect(ade.calls).toEqual([]);
	});

	it("answers show/show-environment the way the contract expects", async () => {
		expect((await tmux(["show", "-Av", "mouse"])).out).toEqual(["off"]);
		expect((await tmux(["show", "-gv", "focus-events"])).out).toEqual(["off"]);

		// An unset environment variable exits 1, as real tmux does — Claude Code
		// reads CLAUDE_CODE_CHILD_SESSION this way and treats non-zero as unset.
		const env = await tmux([
			"show-environment",
			"-g",
			"CLAUDE_CODE_CHILD_SESSION",
		]);
		expect(env.code).toBe(1);
		expect(env.out).toEqual([]);
		expect(ade.calls).toEqual([]);
	});

	it("reports an option that was set, over the default", async () => {
		await tmux(["set-option", "-g", "mouse", "on"]);
		expect((await tmux(["show", "-gv", "mouse"])).out).toEqual(["on"]);
	});
});

describe("fail-soft", () => {
	it("logs an unknown verb and exits 0 with empty stdout", async () => {
		const result = await tmux(["-S", "/sock", "wait-for", "-S", "channel"]);
		expect(result.code).toBe(0);
		expect(result.out).toEqual([]);
		const log = readFileSync(join(dir, LOG_FILENAME), "utf8");
		expect(log).toContain('"event":"unknown-verb"');
		expect(log).toContain('"verb":"wait-for"');
	});

	it("accepts layout verbs ADE's mosaic owns", async () => {
		for (const argv of [
			["select-layout", "-t", "@0", "main-vertical"],
			["resize-pane", "-t", "%0", "-x", "30%"],
		]) {
			const result = await tmux(argv);
			expect(result.code).toBe(0);
			expect(result.out).toEqual([]);
		}
		expect(ade.calls).toEqual([]);
	});

	it("ignores -S and -L socket values whatever they are", async () => {
		for (const flags of [
			["-S", "/tmp/whatever.sock"],
			["-L", "claude-swarm-99999"],
			[],
		]) {
			const result = await tmux([
				...flags,
				"display-message",
				"-p",
				"#{pane_id}",
			]);
			expect(result.code).toBe(0);
			expect(result.out).toEqual(["%0"]);
		}
	});
});

describe("has-session", () => {
	it("fails for a session that was never created", async () => {
		const result = await tmux(["has-session", "-t", "claude-swarm"]);
		expect(result.code).toBe(1);
		expect(result.err.join()).toContain("can't find session: claude-swarm");
	});

	it("succeeds after new-session, and fails again once its tab is gone", async () => {
		await tmux(["new-session", "-d", "-s", "claude-swarm", "-n", "swarm-view"]);
		expect((await tmux(["has-session", "-t", "claude-swarm"])).code).toBe(0);

		// The user closed the swarm tab: reporting 0 here would make Claude skip
		// new-session and target a session that no longer exists.
		ade.tabs.delete("tab-1");
		expect((await tmux(["has-session", "-t", "claude-swarm"])).code).toBe(1);
	});
});

describe("split-window", () => {
	it("maps -h to right, -v to down, -b to the opposite side", async () => {
		await tmux([
			"split-window",
			"-d",
			"-t",
			"%0",
			"-h",
			"-P",
			"-F",
			"#{pane_id}",
		]);
		await tmux([
			"split-window",
			"-d",
			"-t",
			"%0",
			"-v",
			"-P",
			"-F",
			"#{pane_id}",
		]);
		await tmux([
			"split-window",
			"-d",
			"-t",
			"%0",
			"-hb",
			"-P",
			"-F",
			"#{pane_id}",
		]);
		const directions = ade.calls
			.filter((c) => c.cmd === "new-pane")
			.map((c) => c.args.direction);
		expect(directions).toEqual(["right", "down", "left"]);
	});

	it("never passes a command on a split (control plane rejects it there)", async () => {
		await tmux([
			"split-window",
			"-d",
			"-t",
			"%0",
			"-h",
			"-l",
			"70%",
			"-P",
			"-F",
			"#{pane_id}",
			"--",
			"cat",
		]);
		const call = ade.calls.find((c) => c.cmd === "new-pane");
		expect(call?.args.command).toBeUndefined();
		expect(call?.args.type).toBe("terminal");
		// -l 70% is dropped: ADE's mosaic sizes its own tiles.
		expect(call?.args).not.toHaveProperty("size");
	});

	it("allocates ids that do not collide with the leader", async () => {
		const first = await tmux([
			"split-window",
			"-d",
			"-t",
			"%0",
			"-h",
			"-P",
			"-F",
			"#{pane_id}",
		]);
		const second = await tmux([
			"split-window",
			"-d",
			"-t",
			"%1",
			"-v",
			"-P",
			"-F",
			"#{pane_id}",
		]);
		expect(first.out).toEqual(["%1"]);
		expect(second.out).toEqual(["%2"]);
	});
});

describe("respawn-pane", () => {
	const teammate = "cd /work && env A=1 claude --agent-id helper@team";

	async function makeTeammatePane(): Promise<void> {
		await tmux([
			"split-window",
			"-d",
			"-t",
			"%0",
			"-h",
			"-P",
			"-F",
			"#{pane_id}",
		]);
		await tmux(["set-option", "-p", "-t", "%1", "remain-on-exit", "failed"]);
	}

	it("execs the command into the placeholder shell the first time", async () => {
		await makeTeammatePane();
		const result = await tmux([
			"respawn-pane",
			"-k",
			"-t",
			"%1",
			"--",
			teammate,
		]);
		expect(result.code).toBe(0);
		expect(ade.sent.get("pane-1")).toEqual([`exec /bin/sh -c '${teammate}'`]);
		expect(cmds().filter((c) => c === "close-pane").length).toBe(0);
	});

	/**
	 * The re-respawn case. After the first exec there is no shell in the pane:
	 * typing would either feed keystrokes to a live teammate or vanish into a
	 * dead one. The pane must be rebuilt and the tmux id remapped.
	 */
	it("rebuilds the pane on a second respawn and keeps the tmux id stable", async () => {
		await makeTeammatePane();
		await tmux(["respawn-pane", "-k", "-t", "%1", "--", teammate]);
		const before = new CompatStore(dir).read().panes["%1"];
		expect(before?.adePaneId).toBe("pane-1");

		const again = "cd /work && env A=2 claude --agent-id helper-2@team";
		const result = await tmux(["respawn-pane", "-k", "-t", "%1", "--", again]);
		expect(result.code).toBe(0);

		const after = new CompatStore(dir).read().panes["%1"];
		expect(after?.id).toBe("%1");
		expect(after?.adePaneId).not.toBe("pane-1");
		// Old ADE pane closed, new one carries the command.
		expect(cmds()).toContain("close-pane");
		expect(ade.tabs.get("tab-0")).not.toContain("pane-1");
		expect(ade.sent.get(String(after?.adePaneId))).toEqual([
			`exec /bin/sh -c '${again}'`,
		]);
	});

	/**
	 * The PTY race. `new-pane` returns when the renderer's layout store mutates;
	 * the PTY spawns afterwards, so a `send` issued immediately throws and the
	 * teammate never starts. FakeAde models the two stages via
	 * `paneReadyAfterPolls`; against the pre-fix code (which sent straight after
	 * `rebuildPane` with no readiness wait) this test fails with
	 * "NOT_FOUND: Pane pane-N has no live terminal session" and exit 1.
	 */
	it("waits for the rebuilt pane's PTY before sending the exec line", async () => {
		await makeTeammatePane();
		await tmux(["respawn-pane", "-k", "-t", "%1", "--", teammate]);

		// The pane created by the rebuild needs three polls before its PTY is up.
		ade.paneReadyAfterPolls = 3;
		const again = "cd /work && env A=2 claude --agent-id helper-2@team";
		const result = await tmux(["respawn-pane", "-k", "-t", "%1", "--", again]);

		expect(result.err).toEqual([]);
		expect(result.code).toBe(0);
		const after = new CompatStore(dir).read().panes["%1"];
		expect(ade.sent.get(String(after?.adePaneId))).toEqual([
			`exec /bin/sh -c '${again}'`,
		]);
		// It polled rather than guessing a fixed sleep.
		expect(cmds().filter((c) => c === "pane-ready").length).toBeGreaterThan(1);
	});

	it("recovers when the ADE pane vanished entirely", async () => {
		await makeTeammatePane();
		await tmux(["respawn-pane", "-k", "-t", "%1", "--", teammate]);
		// Pane gone from ADE (crash, or the user closed it): splitting off it
		// fails, so the shim falls back to a sibling, then to a new tab.
		ade.tabs.set("tab-0", [LEADER]);

		const result = await tmux([
			"respawn-pane",
			"-k",
			"-t",
			"%1",
			"--",
			teammate,
		]);
		expect(result.code).toBe(0);
		const after = new CompatStore(dir).read().panes["%1"];
		expect(after?.adePaneId).toBeTruthy();
		expect(ade.sent.get(String(after?.adePaneId))).toEqual([
			`exec /bin/sh -c '${teammate}'`,
		]);
	});

	it("reports failure to Claude when the send fails", async () => {
		await makeTeammatePane();
		const failing: ControlApi = {
			request: async (cmd, args) => {
				if (cmd === "send") throw new Error("NOT_FOUND: pane is gone");
				return ade.request(cmd, args);
			},
		};
		const result = await tmux(
			["respawn-pane", "-k", "-t", "%1", "--", teammate],
			{ api: failing },
		);
		// Non-zero is the signal Claude Code turns into SwarmPaneError; swallowing
		// it would leave a teammate that silently never starts.
		expect(result.code).toBe(1);
		expect(result.err.join()).toContain("NOT_FOUND");
	});

	it("quotes a command containing single quotes", async () => {
		await makeTeammatePane();
		const tricky = `cd /work && claude --prompt 'don'"'"'t break'`;
		await tmux(["respawn-pane", "-k", "-t", "%1", "--", tricky]);
		const sent = ade.sent.get("pane-1")?.[0] as string;
		expect(sent).toBe(`exec /bin/sh -c '${tricky.split("'").join("'\\''")}'`);
	});

	it("rejects a respawn with no command", async () => {
		await makeTeammatePane();
		const result = await tmux(["respawn-pane", "-k", "-t", "%1"]);
		expect(result.code).toBe(1);
	});
});

describe("select-pane / kill-pane", () => {
	it("focuses only when no title is given", async () => {
		await tmux([
			"split-window",
			"-d",
			"-t",
			"%0",
			"-h",
			"-P",
			"-F",
			"#{pane_id}",
		]);
		await tmux(["select-pane", "-t", "%1", "-T", "helper"]);
		expect(cmds()).not.toContain("focus-pane");
		expect(new CompatStore(dir).read().panes["%1"]?.title).toBe("helper");

		await tmux(["select-pane", "-t", "%1"]);
		expect(ade.calls.at(-1)).toEqual({
			cmd: "focus-pane",
			args: { pane: "pane-1" },
		});
	});

	it("closes the ADE pane and forgets the mapping", async () => {
		await tmux([
			"split-window",
			"-d",
			"-t",
			"%0",
			"-h",
			"-P",
			"-F",
			"#{pane_id}",
		]);
		expect((await tmux(["kill-pane", "-t", "%1"])).code).toBe(0);
		expect(new CompatStore(dir).read().panes["%1"]).toBeUndefined();
		expect(ade.tabs.get("tab-0")).toEqual([LEADER]);
	});

	it("fails honestly for a pane that was never mapped", async () => {
		const result = await tmux(["kill-pane", "-t", "%42"]);
		expect(result.code).toBe(1);
		expect(result.err.join()).toContain("can't find pane: %42");
	});
});

describe("list-panes", () => {
	it("prunes panes the user closed in ADE", async () => {
		await tmux([
			"split-window",
			"-d",
			"-t",
			"%0",
			"-h",
			"-P",
			"-F",
			"#{pane_id}",
		]);
		expect(
			(await tmux(["list-panes", "-t", "@0", "-F", "#{pane_id}"])).out,
		).toEqual(["%0\n%1"]);

		ade.tabs.set("tab-0", [LEADER]);
		const after = await tmux(["list-panes", "-t", "@0", "-F", "#{pane_id}"]);
		// A stale count here misplaces the next teammate's split target.
		expect(after.out).toEqual(["%0"]);
	});

	it("survives an unreachable app rather than failing the listing", async () => {
		await tmux([
			"split-window",
			"-d",
			"-t",
			"%0",
			"-h",
			"-P",
			"-F",
			"#{pane_id}",
		]);
		const dead: ControlApi = {
			request: async () => {
				throw new Error("ADE app is not running (no control socket)");
			},
		};
		const result = await tmux(["list-panes", "-t", "@0", "-F", "#{pane_id}"], {
			api: dead,
		});
		expect(result.code).toBe(0);
		expect(result.out).toEqual(["%0\n%1"]);
	});
});

describe("verbs in the code but not exercised by the probe", () => {
	it("new-window adds a tab to an existing session", async () => {
		await tmux(["new-session", "-d", "-s", "claude-swarm"]);
		const result = await tmux([
			"new-window",
			"-t",
			"claude-swarm",
			"-n",
			"teammate-helper",
			"-P",
			"-F",
			"#{pane_id}",
		]);
		expect(result.code).toBe(0);
		expect(result.out).toEqual(["%2"]);
		expect(cmds().filter((c) => c === "new-tab").length).toBe(2);
	});

	it("list-windows answers #{window_name}", async () => {
		await tmux(["new-session", "-d", "-s", "claude-swarm", "-n", "swarm-view"]);
		await tmux([
			"new-window",
			"-t",
			"claude-swarm",
			"-n",
			"teammate-helper",
			"-P",
			"-F",
			"#{pane_id}",
		]);
		const result = await tmux([
			"list-windows",
			"-t",
			"claude-swarm",
			"-F",
			"#{window_name}",
		]);
		expect(result.out).toEqual(["swarm-view\nteammate-helper"]);
	});

	it("display-message -p '#{pane_id}' with no -t answers the leader", async () => {
		expect((await tmux(["display-message", "-p", "#{pane_id}"])).out).toEqual([
			"%0",
		]);
	});
});

describe("send-keys / capture-pane (spec verb set, unused by agent teams)", () => {
	it("routes named keys to send-key and text to send", async () => {
		await tmux(["send-keys", "-t", "%0", "hello", "Enter"]);
		expect(ade.calls.map((c) => [c.cmd, c.args.text ?? c.args.key])).toEqual([
			["send", "hello"],
			["send-key", "Enter"],
		]);
	});

	it("-l forces literal, so a key name is typed as text", async () => {
		await tmux(["send-keys", "-l", "-t", "%0", "Enter"]);
		expect(ade.calls).toEqual([
			{ cmd: "send", args: { pane: LEADER, text: "Enter" } },
		]);
	});

	it("capture-pane -p prints the screen", async () => {
		const result = await tmux(["capture-pane", "-p", "-t", "%0"]);
		expect(result.out).toEqual(["screen contents"]);
	});
});

describe("leader binding", () => {
	it("uses the focused pane when ADE_SURFACE_ID is absent", async () => {
		await tmux(["split-window", "-d", "-t", "%0", "-h"], {
			env: { ADE_SURFACE_ID: undefined },
		});
		expect(ade.calls[0]).toEqual({
			cmd: "new-pane",
			args: {
				pane: "focused",
				direction: "right",
				type: "terminal",
				cwd: "/work",
				focus: false,
			},
		});
	});

	it("honours a non-default $TMUX_PANE", async () => {
		const result = await tmux(["display-message", "-p", "#{pane_id}"], {
			env: { TMUX_PANE: "%7" },
		});
		expect(result.out).toEqual(["%7"]);
	});
});
