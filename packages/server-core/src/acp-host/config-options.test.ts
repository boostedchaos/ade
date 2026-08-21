/**
 * The local config gate.
 *
 * Phase 0 ground truth (`planning/spikes/acp-phase0/FINDINGS.md`): the adapter
 * ACCEPTS an invalid `session/set_config_option` value, answers success, and
 * silently downgrades to `default`. A green write proves nothing, so the only
 * real defense is refusing to put the value on the wire at all — which is what
 * the first test here asserts, against the fake child's stdin capture.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { AcpSession, type AcpSessionHandlers } from "./acp-session";
import { setAcpBinaryPathResolver } from "./binary-resolver";
import { ConfigOptionCache, toAcpConfigOption } from "./config-options";
import { FakeAcpChild } from "./fake-acp-child";
import type { AcpSessionUpdate } from "./types";

setAcpBinaryPathResolver(() => "/fake/claude-agent-acp/index.js");

const MODEL_OPTION: SessionConfigOption = {
	id: "model",
	name: "Model",
	type: "select",
	currentValue: "default",
	options: [
		{ value: "default", name: "Default" },
		{ value: "claude-fable-5[1m]", name: "Fable" },
	],
};

const updates: AcpSessionUpdate[] = [];
const handlers: AcpSessionHandlers = {
	onUpdate: (update) => updates.push(update),
	onError: () => {},
	onExit: () => {},
};

let child: FakeAcpChild;

beforeEach(() => {
	updates.length = 0;
	child = new FakeAcpChild();
});

/** Poll until `predicate` holds; fails the test by timing out if it never does. */
async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("condition never became true");
}

function session(paneId = "pane-config"): AcpSession {
	return new AcpSession(
		{ paneId, cwd: process.cwd(), spawnProcess: child.spawnProcess },
		handlers,
	);
}

describe("config gate over the wire", () => {
	it("REJECTS an illegal value and sends nothing", async () => {
		const acp = session();
		await acp.start();
		const framesBefore = child.received.length;

		await expect(
			acp.setConfigOption("model", "totally-not-a-model"),
		).rejects.toThrow(/^acp-invalid-config-value/);

		// The whole point: no frame left the client. Asserted on the child's
		// stdin capture, not on a spy over the session's own method.
		expect(child.framesFor("session/set_config_option")).toHaveLength(0);
		expect(child.received.length).toBe(framesBefore);
		// And the cache still holds the value the adapter declared.
		expect(
			acp.info().configOptions.find((option) => option.id === "model")
				?.currentValue,
		).toBe("default");

		await acp.dispose();
	});

	it("rejects an unknown option id without sending", async () => {
		const acp = session();
		await acp.start();

		await expect(
			acp.setConfigOption("no-such-option", "anything"),
		).rejects.toThrow(/^acp-invalid-config-value/);
		expect(child.framesFor("session/set_config_option")).toHaveLength(0);

		await acp.dispose();
	});

	it("sends a declared value and updates the cache", async () => {
		const acp = session();
		await acp.start();

		await acp.setConfigOption("model", "claude-fable-5[1m]");

		const frame = child.framesFor("session/set_config_option")[0];
		expect(frame?.params?.configId).toBe("model");
		expect(frame?.params?.value).toBe("claude-fable-5[1m]");
		expect(
			acp.info().configOptions.find((option) => option.id === "model")
				?.currentValue,
		).toBe("claude-fable-5[1m]");

		await acp.dispose();
	});

	it("sends a boolean option as a typed boolean on the wire", async () => {
		const acp = session();
		await acp.start();

		await acp.setConfigOption("fast", "true");

		const frame = child.framesFor("session/set_config_option")[0];
		expect(frame?.params?.type).toBe("boolean");
		expect(frame?.params?.value).toBe(true);

		await acp.dispose();
	});

	it("lets a config_option_update notification overwrite the cache", async () => {
		const acp = session();
		await acp.start();

		child.sessionUpdate({
			sessionUpdate: "config_option_update",
			configOptions: [
				{ ...MODEL_OPTION, currentValue: "claude-fable-5[1m]" },
			] as SessionConfigOption[],
		});
		await waitFor(() =>
			updates.some((update) => update.kind === "config_option_update"),
		);

		const options = acp.info().configOptions;
		expect(options).toHaveLength(1);
		expect(options[0]?.currentValue).toBe("claude-fable-5[1m]");
		expect(updates.at(-1)).toEqual({
			kind: "config_option_update",
			options: [
				{
					id: "model",
					name: "Model",
					values: [
						{ id: "default", label: "Default" },
						{ id: "claude-fable-5[1m]", label: "Fable" },
					],
					currentValue: "claude-fable-5[1m]",
				},
			],
		});

		await acp.dispose();
	});
});

describe("ConfigOptionCache", () => {
	it("normalizes a boolean option into a two-value select", () => {
		expect(
			toAcpConfigOption({
				id: "fast",
				name: "Fast",
				type: "boolean",
				currentValue: true,
			}),
		).toEqual({
			id: "fast",
			name: "Fast",
			values: [
				{ id: "true", label: "On" },
				{ id: "false", label: "Off" },
			],
			currentValue: "true",
		});
	});

	it("flattens grouped select options", () => {
		const cache = new ConfigOptionCache();
		cache.replaceAll([
			{
				id: "model",
				name: "Model",
				type: "select",
				currentValue: "sonnet",
				options: [
					{
						group: "anthropic",
						name: "Anthropic",
						options: [
							{ value: "sonnet", name: "Sonnet" },
							{ value: "haiku", name: "Haiku" },
						],
					},
				],
			},
		]);

		expect(cache.get("model")?.values?.map((value) => value.id)).toEqual([
			"sonnet",
			"haiku",
		]);
	});

	it("passes through a free-form option with no declared values", () => {
		const cache = new ConfigOptionCache();
		cache.replaceAll([
			{
				id: "freeform",
				name: "Free form",
				type: "select",
				currentValue: "",
				options: [],
			},
		]);

		expect(() => cache.assertValid("freeform", "anything")).not.toThrow();
	});

	it("replaceAll discards the previous options", () => {
		const cache = new ConfigOptionCache();
		cache.replaceAll([MODEL_OPTION]);
		cache.replaceAll([
			{ id: "fast", name: "Fast", type: "boolean", currentValue: false },
		]);

		expect(cache.get("model")).toBeUndefined();
		expect(cache.isBoolean("fast")).toBe(true);
		expect(cache.list()).toHaveLength(1);
	});

	it("list() hands back copies, not the live values array", () => {
		const cache = new ConfigOptionCache();
		cache.replaceAll([MODEL_OPTION]);

		const listed = cache.list();
		listed[0]?.values?.push({ id: "injected" });
		expect(cache.get("model")?.values).toHaveLength(2);
	});
});
