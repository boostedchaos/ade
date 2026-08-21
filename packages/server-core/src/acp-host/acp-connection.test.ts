/**
 * The wire: `sessionUpdate` mapping and the `fs/*` sandbox.
 *
 * The mapping tests call `mapSessionUpdate` directly (one case per modelled
 * kind); the sandbox tests drive the real client handlers over a real
 * `ndJsonStream`, so a rejection here is the rejection an agent would see.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
	mapSessionUpdate,
	resolveInsideRoot,
	UNSTAMPED_CONFIG_SEQ,
} from "./acp-connection";
import { AcpSession } from "./acp-session";
import { setAcpBinaryPathResolver } from "./binary-resolver";
import { FakeAcpChild, FIXTURE_SESSION_ID } from "./fake-acp-child";

setAcpBinaryPathResolver(() => "/fake/claude-agent-acp/index.js");

describe("mapSessionUpdate", () => {
	it("maps agent_message_chunk and agent_thought_chunk to text", () => {
		expect(
			mapSessionUpdate({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "hello" },
			}),
		).toEqual({ kind: "agent_message_chunk", text: "hello" });

		expect(
			mapSessionUpdate({
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "thinking" },
			}),
		).toEqual({ kind: "agent_thought_chunk", text: "thinking" });
	});

	it("maps a non-text content chunk to an empty string rather than throwing", () => {
		expect(
			mapSessionUpdate({
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "image",
					data: "AAAA",
					mimeType: "image/png",
				},
			}),
		).toEqual({ kind: "agent_message_chunk", text: "" });
	});

	it("maps tool_call and tool_call_update, carrying the payload verbatim", () => {
		const toolCall = {
			sessionUpdate: "tool_call",
			toolCallId: "tool-1",
			title: "Read file",
			status: "pending",
		} satisfies SessionUpdate;
		expect(mapSessionUpdate(toolCall)).toEqual({
			kind: "tool_call",
			toolCall,
		});

		const toolCallUpdate = {
			sessionUpdate: "tool_call_update",
			toolCallId: "tool-1",
			status: "completed",
		} satisfies SessionUpdate;
		expect(mapSessionUpdate(toolCallUpdate)).toEqual({
			kind: "tool_call_update",
			toolCall: toolCallUpdate,
		});
	});

	it("maps plan to its entries", () => {
		const entries = [
			{ content: "step one", priority: "high", status: "pending" },
		] as const;
		expect(
			mapSessionUpdate({
				sessionUpdate: "plan",
				entries: [...entries],
			}),
		).toEqual({ kind: "plan", entries: [...entries] });
	});

	it("maps available_commands_update to the command list", () => {
		const commands = [{ name: "wrap-up", description: "Wrap up" }];
		expect(
			mapSessionUpdate({
				sessionUpdate: "available_commands_update",
				availableCommands: commands,
			}),
		).toEqual({ kind: "available_commands_update", commands });
	});

	it("maps config_option_update through the normalizer", () => {
		expect(
			mapSessionUpdate({
				sessionUpdate: "config_option_update",
				configOptions: [
					{ id: "fast", name: "Fast", type: "boolean", currentValue: true },
				],
			}),
		).toEqual({
			kind: "config_option_update",
			// The mapper has no session state to read a generation from;
			// `AcpSession` stamps the real one before emitting (A1).
			seq: UNSTAMPED_CONFIG_SEQ,
			options: [
				{
					id: "fast",
					name: "Fast",
					values: [
						{ id: "true", label: "On" },
						{ id: "false", label: "Off" },
					],
					currentValue: "true",
				},
			],
		});
	});

	it("maps current_mode_update to the mode id", () => {
		expect(
			mapSessionUpdate({
				sessionUpdate: "current_mode_update",
				currentModeId: "plan",
			}),
		).toEqual({ kind: "current_mode_update", modeId: "plan" });
	});

	it("maps session_info_update, defaulting absent fields to null", () => {
		expect(
			mapSessionUpdate({
				sessionUpdate: "session_info_update",
				title: "A title",
				updatedAt: "2026-08-21T00:00:00Z",
			}),
		).toEqual({
			kind: "session_info_update",
			title: "A title",
			updatedAt: "2026-08-21T00:00:00Z",
		});

		expect(mapSessionUpdate({ sessionUpdate: "session_info_update" })).toEqual({
			kind: "session_info_update",
			title: null,
			updatedAt: null,
		});
	});

	it("maps usage_update, defaulting an absent cost to null", () => {
		expect(
			mapSessionUpdate({
				sessionUpdate: "usage_update",
				used: 1200,
				size: 200_000,
				cost: { amount: 0.12, currency: "USD" },
			}),
		).toEqual({
			kind: "usage_update",
			used: 1200,
			size: 200_000,
			cost: { amount: 0.12, currency: "USD" },
		});

		expect(
			mapSessionUpdate({ sessionUpdate: "usage_update", used: 1, size: 2 }),
		).toEqual({ kind: "usage_update", used: 1, size: 2, cost: null });
	});

	it("falls back to { kind: 'unknown', raw } for a protocol kind it does not model", () => {
		// `user_message_chunk` is a REAL protocol kind with no Phase 1 consumer,
		// so this is the fallback an adapter can actually reach today.
		const raw = {
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "typed by the user" },
		} satisfies SessionUpdate;
		expect(mapSessionUpdate(raw)).toEqual({ kind: "unknown", raw });
	});

	it("falls back to { kind: 'unknown', raw } for a kind a future adapter invents", () => {
		const raw = { sessionUpdate: "some_future_kind", whatever: 1 };
		expect(mapSessionUpdate(raw as unknown as SessionUpdate)).toEqual({
			kind: "unknown",
			raw,
		});
	});
});

describe("resolveInsideRoot", () => {
	let root: string;
	let outside: string;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "acp-root-"));
		outside = await mkdtemp(join(tmpdir(), "acp-outside-"));
		await writeFile(join(root, "inside.txt"), "in", "utf8");
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(outside, "secret.txt"), "out", "utf8");
		await symlink(join(outside, "secret.txt"), join(root, "escape-link"));
	});

	it("resolves a path inside the root", async () => {
		expect(await resolveInsideRoot(root, "inside.txt")).toContain("inside.txt");
	});

	it("resolves a not-yet-existing file under an existing directory", async () => {
		const resolved = await resolveInsideRoot(root, "nested/new-file.txt");
		expect(resolved).toContain("new-file.txt");
	});

	it("rejects a relative escape", async () => {
		await expect(resolveInsideRoot(root, "../escaped.txt")).rejects.toThrow(
			/outside the session root/,
		);
	});

	it("rejects an absolute path outside the root", async () => {
		await expect(
			resolveInsideRoot(root, join(outside, "secret.txt")),
		).rejects.toThrow(/outside the session root/);
	});

	it("rejects a symlink that points out of the root", async () => {
		// A lexical check alone is satisfied by this path; only realpath catches it.
		await expect(resolveInsideRoot(root, "escape-link")).rejects.toThrow(
			/outside the session root/,
		);
	});

	it("accepts the root itself", async () => {
		expect(await resolveInsideRoot(root, ".")).toBeTruthy();
	});

	it("accepts a legitimate file whose name STARTS with two dots", async () => {
		// `rel.startsWith("..")` refuses this. Only `rel === ".."` or a first
		// segment of ".." is an escape.
		await writeFile(join(root, "..hidden"), "not an escape", "utf8");
		expect(await resolveInsideRoot(root, "..hidden")).toContain("..hidden");
		expect(await resolveInsideRoot(root, "nested/../..hidden")).toContain(
			"..hidden",
		);
	});

	it("still refuses a real traversal that lands next to such a name", async () => {
		// The sibling of the file above, one level UP: same "..h" prefix on the
		// relative path, opposite verdict.
		await expect(
			resolveInsideRoot(root, join("..", `${basename(root)}-sibling`)),
		).rejects.toThrow(/outside the session root/);
	});
});

describe("what the SDK does with an unrecognised sessionUpdate kind", () => {
	it("never reaches mapSessionUpdate: the inbound union is CLOSED", async () => {
		// The `{ kind: "unknown", raw }` fallback is documented as protecting the
		// host from an adapter version bump. It cannot: the SDK validates
		// `session/update` against a closed zod union BEFORE dispatching, so a
		// kind the schema does not know is rejected upstream. Measured here, over
		// the real SDK: the notification produces no update, and the connection
		// survives it (the next legal update still lands).
		const child = new FakeAcpChild();
		const seen: string[] = [];
		const session = new AcpSession(
			{
				paneId: "pane-unknown-kind",
				cwd: process.cwd(),
				spawnProcess: child.spawnProcess,
			},
			{
				onUpdate: (update) => seen.push(update.kind),
				onError: () => {},
				onExit: () => {},
			},
		);
		await session.start();

		child.sessionUpdate({ sessionUpdate: "invented_by_a_future_adapter" });
		await Bun.sleep(20);
		expect(seen).toHaveLength(0);

		child.sessionUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "still connected" },
		});
		await Bun.sleep(20);
		expect(seen).toEqual(["agent_message_chunk"]);

		await session.dispose();
	}, 20_000);
});

describe("fs/* handlers over the wire", () => {
	let root: string;
	let outside: string;
	let child: FakeAcpChild;
	let session: AcpSession;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "acp-fsroot-"));
		outside = await mkdtemp(join(tmpdir(), "acp-fsout-"));
		await writeFile(
			join(root, "readme.md"),
			"hello from the workspace",
			"utf8",
		);
		await writeFile(join(outside, "secret.txt"), "top secret", "utf8");

		child = new FakeAcpChild();
		session = new AcpSession(
			{ paneId: "pane-fs", cwd: root, spawnProcess: child.spawnProcess },
			{ onUpdate: () => {}, onError: () => {}, onExit: () => {} },
		);
		await session.start();
	});

	afterAll(async () => {
		await session.dispose();
	});

	it("reads a file inside the session root", async () => {
		const result = await child.request("fs/read_text_file", {
			sessionId: FIXTURE_SESSION_ID,
			path: "readme.md",
		});
		expect(result).toEqual({ content: "hello from the workspace" });
	});

	it("writes a file inside the session root", async () => {
		await child.request("fs/write_text_file", {
			sessionId: FIXTURE_SESSION_ID,
			path: "written.txt",
			content: "written by the agent",
		});
		expect(await readFile(join(root, "written.txt"), "utf8")).toBe(
			"written by the agent",
		);
	});

	it("refuses to read outside the session root", async () => {
		await expect(
			child.request("fs/read_text_file", {
				sessionId: FIXTURE_SESSION_ID,
				path: join(outside, "secret.txt"),
			}),
		).rejects.toThrow(/outside the session root/);
	});

	it("refuses to write outside the session root", async () => {
		await expect(
			child.request("fs/write_text_file", {
				sessionId: FIXTURE_SESSION_ID,
				path: "../escaped.txt",
				content: "should never land",
			}),
		).rejects.toThrow(/outside the session root/);
	});
});
