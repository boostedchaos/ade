import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompatStore, emptyStore, nextId, STORE_FILENAME } from "./store";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ade-tmux-store-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("CompatStore", () => {
	it("starts empty and publishes what a transaction leaves behind", async () => {
		const store = new CompatStore(dir);
		expect(store.read().panes).toEqual({});

		await store.transact((data) => {
			data.panes["%1"] = {
				id: "%1",
				windowId: "@0",
				adePaneId: "ade-pane-1",
				title: "helper",
				options: { "remain-on-exit": "failed" },
				state: "shell",
				command: null,
			};
		});

		expect(new CompatStore(dir).read().panes["%1"]?.adePaneId).toBe(
			"ade-pane-1",
		);
	});

	it("writes atomically — never a partial file, no temp left behind", async () => {
		const store = new CompatStore(dir);
		await store.transact((data) => {
			for (let i = 0; i < 500; i++) nextId(data, "pane");
		});
		const raw = readFileSync(join(dir, STORE_FILENAME), "utf8");
		expect(() => JSON.parse(raw)).not.toThrow();
		const leftovers = spawnSync("sh", ["-c", `ls ${dir} | grep tmp || true`]);
		expect(leftovers.stdout.toString().trim()).toBe("");
	});

	it("heals a corrupt store instead of stranding every mapping", () => {
		writeFileSync(join(dir, STORE_FILENAME), "{ not json");
		expect(new CompatStore(dir).read()).toEqual(emptyStore());
	});

	it("releases the lock even when the transaction throws", async () => {
		const store = new CompatStore(dir);
		await expect(
			store.transact(() => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(store.lockPath)).toBe(false);
		// And the next transaction still works.
		await store.transact((data) => {
			data.globalOptions.mouse = "on";
		});
		expect(store.read().globalOptions.mouse).toBe("on");
	});

	it("keeps work done before a throw (a created pane must not be lost)", async () => {
		const store = new CompatStore(dir);
		await store
			.transact((data) => {
				data.globalOptions.a = "1";
			})
			.catch(() => {});
		await store
			.transact((data) => {
				data.globalOptions.b = "2";
				throw new Error("late failure");
			})
			.catch(() => {});
		expect(store.read().globalOptions).toEqual({ a: "1", b: "2" });
	});

	/**
	 * The real risk: the probe shows one-shot execFile invocations that can
	 * overlap, and each does a read-modify-write spanning an await. Without the
	 * lock, allocations collide and ids are reused.
	 */
	it("serialises concurrent in-process writers with no lost updates", async () => {
		const writers = 24;
		const allocated = await Promise.all(
			Array.from({ length: writers }, () => {
				const store = new CompatStore(dir);
				return store.transact(async (data) => {
					const id = nextId(data, "pane");
					// Force an await inside the critical section, the way a
					// control-plane round trip does.
					await new Promise((resolve) => setTimeout(resolve, 1));
					data.panes[id] = {
						id,
						windowId: "@0",
						adePaneId: `ade-${id}`,
						title: null,
						options: {},
						state: "shell",
						command: null,
					};
					return id;
				});
			}),
		);

		expect(new Set(allocated).size).toBe(writers);
		const final = new CompatStore(dir).read();
		expect(Object.keys(final.panes).length).toBe(writers);
		expect(final.counters.pane).toBe(writers);
	});

	it("serialises concurrent PROCESSES, not just concurrent promises", async () => {
		// Separate processes are the actual deployment shape; an in-process test
		// alone would pass on a lock implemented with a module-level variable.
		const script = join(dir, "writer.mjs");
		const storeModule = join(import.meta.dir, "store.ts");
		writeFileSync(
			script,
			[
				`import { CompatStore, nextId } from ${JSON.stringify(storeModule)};`,
				`const store = new CompatStore(${JSON.stringify(dir)});`,
				"const id = await store.transact(async (data) => {",
				"  const id = nextId(data, 'pane');",
				"  await new Promise((r) => setTimeout(r, 5));",
				"  data.panes[id] = { id, windowId: '@0', adePaneId: 'x', title: null, options: {}, state: 'shell', command: null };",
				"  return id;",
				"});",
				"process.stdout.write(id);",
			].join("\n"),
		);

		// spawnSync would serialise them and prove nothing — these must overlap.
		const procs = await Promise.all(
			Array.from(
				{ length: 8 },
				() =>
					new Promise<{ code: number | null; out: string }>((resolve) => {
						const child = spawn("bun", [script]);
						let out = "";
						child.stdout.on("data", (chunk) => {
							out += String(chunk);
						});
						child.on("close", (code) => resolve({ code, out }));
					}),
			),
		);
		for (const proc of procs) expect(proc.code).toBe(0);
		const ids = procs.map((p) => p.out.trim());
		expect(new Set(ids).size).toBe(8);
		expect(Object.keys(new CompatStore(dir).read().panes).length).toBe(8);
	});
});
