import { describe, expect, it } from "bun:test";
import { AgentSessionRegistry, type AgentSessionTransition } from "./registry";

function collect(registry: AgentSessionRegistry): AgentSessionTransition[] {
	const seen: AgentSessionTransition[] = [];
	registry.onTransition((t) => seen.push(t));
	return seen;
}

describe("AgentSessionRegistry", () => {
	it("creates a record on the first event and reports the transition", () => {
		const registry = new AgentSessionRegistry();
		const seen = collect(registry);

		const transition = registry.applyEvent({
			surfaceId: "pane-1",
			state: "working",
			workspaceId: "ws-1",
			sessionId: "sess-1",
			transcriptPath: "/tmp/t.jsonl",
			at: 1000,
		});

		expect(transition).toMatchObject({
			surfaceId: "pane-1",
			from: "idle",
			to: "working",
			cause: "hook",
		});
		expect(seen).toHaveLength(1);
		expect(registry.get("pane-1")).toMatchObject({
			workspaceId: "ws-1",
			sessionId: "sess-1",
			transcriptPath: "/tmp/t.jsonl",
			state: "working",
			lastActivityAt: 1000,
		});
	});

	it("walks the full spec state set", () => {
		const registry = new AgentSessionRegistry();
		const seen = collect(registry);
		const order = [
			"idle",
			"working",
			"needsInput",
			"working",
			"ended",
		] as const;
		for (const [i, state] of order.entries()) {
			registry.applyEvent({ surfaceId: "p", state, at: 100 + i });
		}
		// The first event announces the session even when from === to: a
		// subscriber has to learn the pane exists before it can care what it
		// does. Deduplication only applies once a record is present.
		expect(seen.map((t) => `${t.from}->${t.to}`)).toEqual([
			"idle->idle",
			"idle->working",
			"working->needsInput",
			"needsInput->working",
			"working->ended",
		]);
	});

	it("does not re-emit when the state is unchanged, but does bump activity", () => {
		const registry = new AgentSessionRegistry();
		registry.applyEvent({ surfaceId: "p", state: "working", at: 1000 });
		const seen = collect(registry);

		expect(
			registry.applyEvent({ surfaceId: "p", state: "working", at: 5000 }),
		).toBeNull();
		expect(seen).toHaveLength(0);
		expect(registry.get("p")?.lastActivityAt).toBe(5000);
	});

	it("keeps fields an event does not carry", () => {
		const registry = new AgentSessionRegistry();
		registry.applyEvent({
			surfaceId: "p",
			state: "working",
			workspaceId: "ws-1",
			transcriptPath: "/tmp/t.jsonl",
		});
		// A Stop hook reports no transcript path; it must not erase the one we have.
		registry.applyEvent({ surfaceId: "p", state: "idle" });

		expect(registry.get("p")).toMatchObject({
			workspaceId: "ws-1",
			transcriptPath: "/tmp/t.jsonl",
			state: "idle",
		});
	});

	it("ends a session when its PTY exits, and only once", () => {
		const registry = new AgentSessionRegistry();
		registry.applyEvent({ surfaceId: "p", state: "working" });
		const seen = collect(registry);

		expect(registry.markEnded("p")?.cause).toBe("pty-exit");
		expect(registry.markEnded("p")).toBeNull();
		expect(seen).toHaveLength(1);
	});

	it("ignores a PTY exit for a pane it has never seen", () => {
		const registry = new AgentSessionRegistry();
		expect(registry.markEnded("unknown-pane")).toBeNull();
	});

	describe("correctStuck — the transcript may correct, never invent", () => {
		it("moves a stuck working session", () => {
			const registry = new AgentSessionRegistry();
			registry.applyEvent({ surfaceId: "p", state: "working" });
			const transition = registry.correctStuck("p", "idle");
			expect(transition).toMatchObject({
				from: "working",
				to: "idle",
				cause: "transcript-correction",
			});
		});

		it("refuses to touch a session that is not working", () => {
			const registry = new AgentSessionRegistry();
			registry.applyEvent({ surfaceId: "p", state: "idle" });
			expect(registry.correctStuck("p", "needsInput")).toBeNull();
			expect(registry.get("p")?.state).toBe("idle");
		});

		it("refuses to create a session for an unknown pane", () => {
			const registry = new AgentSessionRegistry();
			expect(registry.correctStuck("ghost", "idle")).toBeNull();
			expect(registry.get("ghost")).toBeUndefined();
		});

		it("refuses a no-op correction back to working", () => {
			const registry = new AgentSessionRegistry();
			registry.applyEvent({ surfaceId: "p", state: "working" });
			expect(registry.correctStuck("p", "working")).toBeNull();
		});
	});

	describe("reconcile", () => {
		it("ends loaded sessions whose pane is gone and leaves live ones alone", () => {
			const registry = new AgentSessionRegistry();
			registry.load([
				{
					surfaceId: "gone",
					workspaceId: "ws",
					agentKind: "claude",
					sessionId: null,
					transcriptPath: null,
					state: "working",
					pid: null,
					progress: null,
					lastActivityAt: 1,
				},
				{
					surfaceId: "live",
					workspaceId: "ws",
					agentKind: "claude",
					sessionId: null,
					transcriptPath: null,
					state: "needsInput",
					pid: null,
					progress: null,
					lastActivityAt: 2,
				},
			]);

			const transitions = registry.reconcile(new Set(["live"]));

			expect(transitions).toHaveLength(1);
			expect(transitions[0]).toMatchObject({
				surfaceId: "gone",
				to: "ended",
				cause: "reconcile",
			});
			expect(registry.get("live")?.state).toBe("needsInput");
		});

		it("emits nothing on load itself", () => {
			const registry = new AgentSessionRegistry();
			const seen = collect(registry);
			registry.load([
				{
					surfaceId: "p",
					workspaceId: null,
					agentKind: "claude",
					sessionId: null,
					transcriptPath: null,
					state: "working",
					pid: null,
					progress: null,
					lastActivityAt: 1,
				},
			]);
			expect(seen).toHaveLength(0);
		});
	});

	it("finds only stale working sessions as stuck candidates", () => {
		const registry = new AgentSessionRegistry();
		registry.applyEvent({ surfaceId: "stale", state: "working", at: 0 });
		registry.applyEvent({ surfaceId: "fresh", state: "working", at: 9_000 });
		registry.applyEvent({ surfaceId: "waiting", state: "needsInput", at: 0 });

		const stuck = registry.stuckCandidates(10_000, 10_000);
		expect(stuck.map((r) => r.surfaceId)).toEqual(["stale"]);
	});

	it("lists most-recently-active first", () => {
		const registry = new AgentSessionRegistry();
		registry.applyEvent({ surfaceId: "old", state: "idle", at: 1 });
		registry.applyEvent({ surfaceId: "new", state: "idle", at: 99 });
		expect(registry.list().map((r) => r.surfaceId)).toEqual(["new", "old"]);
	});

	it("survives a subscriber that throws", () => {
		const registry = new AgentSessionRegistry();
		registry.onTransition(() => {
			throw new Error("boom");
		});
		const seen = collect(registry);
		expect(() =>
			registry.applyEvent({ surfaceId: "p", state: "working" }),
		).not.toThrow();
		expect(seen).toHaveLength(1);
	});
});

describe("progress", () => {
	it("refuses to create a session — it annotates an existing one", () => {
		const registry = new AgentSessionRegistry();
		expect(registry.setProgress("nobody", 50)).toBeNull();
		expect(registry.get("nobody")).toBeUndefined();
	});

	it("attaches a reading to a live session and clears it on request", () => {
		const registry = new AgentSessionRegistry();
		registry.applyEvent({ surfaceId: "p", state: "working" });
		expect(registry.setProgress("p", 60)?.progress).toBe(60);
		expect(registry.setProgress("p", null)?.progress).toBeNull();
	});

	it("keeps 0 distinct from null", () => {
		const registry = new AgentSessionRegistry();
		registry.applyEvent({ surfaceId: "p", state: "working" });
		expect(registry.setProgress("p", 0)?.progress).toBe(0);
	});

	it("emits no transition — progress is not a state change", () => {
		const registry = new AgentSessionRegistry();
		registry.applyEvent({ surfaceId: "p", state: "working" });
		const seen = collect(registry);
		registry.setProgress("p", 40);
		expect(seen).toHaveLength(0);
	});

	it("survives working -> needsInput, because the run is still going", () => {
		const registry = new AgentSessionRegistry();
		registry.applyEvent({ surfaceId: "p", state: "working" });
		registry.setProgress("p", 40);
		registry.applyEvent({ surfaceId: "p", state: "needsInput" });
		expect(registry.get("p")?.progress).toBe(40);
	});

	it("clears when the run reaches idle", () => {
		const registry = new AgentSessionRegistry();
		registry.applyEvent({ surfaceId: "p", state: "working" });
		registry.setProgress("p", 40);
		registry.applyEvent({ surfaceId: "p", state: "idle" });
		expect(registry.get("p")?.progress).toBeNull();
	});

	it("clears when the PTY exits", () => {
		const registry = new AgentSessionRegistry();
		registry.applyEvent({ surfaceId: "p", state: "working" });
		registry.setProgress("p", 90);
		registry.markEnded("p");
		expect(registry.get("p")?.progress).toBeNull();
	});

	it("clears when the transcript corrector unsticks a session", () => {
		const registry = new AgentSessionRegistry();
		registry.applyEvent({ surfaceId: "p", state: "working" });
		registry.setProgress("p", 90);
		registry.correctStuck("p", "idle");
		expect(registry.get("p")?.progress).toBeNull();
	});
});
