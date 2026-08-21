/**
 * Phase 4: the read-back path (`session/resume`) and the unlisted-model gate.
 *
 * Doctrine of `config-options.test.ts`: the fake child is a real process seam,
 * so every claim here is asserted against the frames Argus actually wrote to
 * stdin — never against a spy over the session's own methods. That matters
 * more here than anywhere else in the host, because the two facts this file
 * defends are both invisible from the caller's side:
 *
 *   1. A resume whose params do not byte-match `session/new`'s silently tears
 *      the live session down and rebuilds it (design §Ground truth 3). Nothing
 *      errors, so only the wire shows it.
 *   2. `session/set_config_option` answers success for a value it silently
 *      resolved to something else (§Ground truth 2). Only the read-back's
 *      reported `currentValue` distinguishes a write that landed from one that
 *      did not.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { AcpSession, type AcpSessionHandlers } from "./acp-session";
import { setAcpBinaryPathResolver } from "./binary-resolver";
import { toAcpConfigOption } from "./config-options";
import { FakeAcpChild, fixtureConfigOptions } from "./fake-acp-child";
import type { AcpSessionUpdate } from "./types";

setAcpBinaryPathResolver(() => "/fake/claude-agent-acp/index.js");

const updates: AcpSessionUpdate[] = [];
const handlers: AcpSessionHandlers = {
	onUpdate: (update) => updates.push(update),
	onError: () => {},
	onExit: () => {},
};

const CWD = "/repo/phase-4";

let child: FakeAcpChild;

beforeEach(() => {
	updates.length = 0;
	child = new FakeAcpChild();
});

function session(paneId = "pane-readback"): AcpSession {
	return new AcpSession(
		{ paneId, cwd: CWD, spawnProcess: child.spawnProcess },
		handlers,
	);
}

/** `{ cwd, mcpServers }` of a captured frame, i.e. the session fingerprint. */
function fingerprint(params: Record<string, unknown> | undefined) {
	return { cwd: params?.cwd, mcpServers: params?.mcpServers };
}

// =============================================================================
// D2 — resume params byte-match session/new params
// =============================================================================

describe("session/resume fingerprint (D2)", () => {
	it("resends session/new's exact cwd and mcpServers", async () => {
		const acp = session();
		await acp.start();

		await acp.resume();

		const newFrame = child.framesFor("session/new")[0];
		const resumeFrame = child.framesFor("session/resume")[0];
		expect(newFrame).toBeDefined();
		expect(resumeFrame).toBeDefined();
		// Deep-equal, not "looks right": a freshly-built equivalent is exactly
		// the regression this asserts against.
		expect(fingerprint(resumeFrame?.params)).toEqual(
			fingerprint(newFrame?.params),
		);
		expect(resumeFrame?.params?.sessionId).toBe(child.sessionId);
		expect(resumeFrame?.params?.cwd).toBe(CWD);

		await acp.dispose();
	});

	it("uses session/resume, never session/load", async () => {
		// `session/load` replays the whole conversation back through
		// `session/update` and would re-render the transcript.
		const acp = session();
		await acp.start();
		await acp.resume();

		expect(child.sentMethods()).not.toContain("session/load");

		await acp.dispose();
	});

	it("PROVES THE CHECK FIRES: a mismatched cwd is caught", async () => {
		// The control. The comparison above is only worth anything if it can
		// fail, so run the identical assertion against a session that resumed
		// with a different cwd and show it throws.
		const observed: Record<string, unknown>[] = [];
		child.setHandler("session/resume", (params) => {
			observed.push(params);
			return { configOptions: fixtureConfigOptions() };
		});

		const acp = session();
		await acp.start();
		await acp.resume();

		const newParams = child.framesFor("session/new")[0]?.params;
		const goodResume = observed[0];
		expect(fingerprint(goodResume)).toEqual(fingerprint(newParams));

		// What the adapter would have received had the code regressed to
		// rebuilding the params. Same assertion, opposite outcome.
		const regressed = { ...goodResume, cwd: `${CWD}/` };
		expect(() =>
			expect(fingerprint(regressed)).toEqual(fingerprint(newParams)),
		).toThrow();

		await acp.dispose();
	});
});

// =============================================================================
// D3 step 1/2 — the unlisted-model escape hatch
// =============================================================================

describe("allowUnlisted (D3)", () => {
	it("puts an unlisted MODEL id on the wire when allowUnlisted is set", async () => {
		const acp = session();
		await acp.start();

		await acp.setConfigOption("model", "some-unlisted-model", {
			allowUnlisted: true,
		});

		const frames = child.framesFor("session/set_config_option");
		expect(frames).toHaveLength(1);
		expect(frames[0]?.params?.configId).toBe("model");
		expect(frames[0]?.params?.value).toBe("some-unlisted-model");

		await acp.dispose();
	});

	it("still gates an unlisted model when allowUnlisted is NOT passed", async () => {
		const acp = session();
		await acp.start();

		await expect(
			acp.setConfigOption("model", "some-unlisted-model"),
		).rejects.toThrow(/^acp-invalid-config-value/);
		expect(child.framesFor("session/set_config_option")).toHaveLength(0);

		await acp.dispose();
	});

	it("NEVER lets an unlisted NON-model value reach the wire", async () => {
		const acp = session();
		await acp.start();

		// allowUnlisted is set, and it must not help: `effort` has a declared
		// list and an undeclared value there has no fuzzy-resolution floor.
		await expect(
			acp.setConfigOption("effort", "ludicrous", { allowUnlisted: true }),
		).rejects.toThrow(/^acp-invalid-config-value/);
		await expect(
			acp.setConfigOption("fast", "maybe", { allowUnlisted: true }),
		).rejects.toThrow(/^acp-invalid-config-value/);

		expect(child.framesFor("session/set_config_option")).toHaveLength(0);

		await acp.dispose();
	});
});

// =============================================================================
// D3 step 3 — the read-back re-seeds the cache
// =============================================================================

describe("read-back (D3)", () => {
	it("re-seeds the cache from the resume response", async () => {
		const acp = session();
		await acp.start();
		expect(
			acp.info().configOptions.find((option) => option.id === "model")
				?.currentValue,
		).toBe("default");

		child.setHandler("session/resume", () => ({
			configOptions: [
				{
					id: "model",
					name: "Model",
					type: "select",
					currentValue: "haiku",
					options: [
						{ value: "default", name: "Default" },
						{ value: "haiku", name: "Haiku" },
					],
				},
			] as SessionConfigOption[],
		}));

		const returned = await acp.resume();

		expect(returned.find((option) => option.id === "model")?.currentValue).toBe(
			"haiku",
		);
		// And the cache itself, not just the return value.
		expect(acp.info().configOptions.map((option) => option.id)).toEqual([
			"model",
		]);

		await acp.dispose();
	});

	it("does NOT empty the bar when resume reports no configOptions at all", async () => {
		// Absent is not the same claim as empty (`AcpSession.resume`).
		const acp = session();
		await acp.start();

		child.setHandler("session/resume", () => ({}));
		const returned = await acp.resume();

		expect(returned.map((option) => option.id)).toEqual([
			"model",
			"effort",
			"fast",
		]);

		await acp.dispose();
	});

	it("verified:false — the read-back reports a model we did not ask for", async () => {
		// The Phase 0 finding made visible. The write is answered GREEN, and
		// the resume reports something else entirely.
		const acp = session();
		await acp.start();

		// The fake's default set_config_option returns `configOptions: []`,
		// which would leave the optimistic local write in the cache. Override
		// it so the write is green and silent, exactly like the real adapter.
		child.setHandler("session/set_config_option", () => ({
			configOptions: [],
		}));
		child.setHandler("session/resume", () => ({
			configOptions: [
				{
					id: "model",
					name: "Model",
					type: "select",
					// The adapter fuzzy-resolved the request to `default`.
					currentValue: "default",
					options: [
						{ value: "default", name: "Default" },
						{ value: "claude-fable-5[1m]", name: "Fable" },
					],
				},
			] as SessionConfigOption[],
		}));

		const requested = "totally-made-up-model";
		await acp.setConfigOption("model", requested, { allowUnlisted: true });

		// The write alone is a lie: the cache now claims the requested value.
		expect(
			acp.info().configOptions.find((option) => option.id === "model")
				?.currentValue,
		).toBe(requested);

		const readBack = await acp.resume();
		const actualValue = readBack.find(
			(option) => option.id === "model",
		)?.currentValue;

		expect(actualValue).toBe("default");
		expect(actualValue === requested).toBe(false);

		await acp.dispose();
	});

	it("verified:true — the read-back reports what we asked for", async () => {
		// The positive control for the test above: same machinery, agreeing
		// read-back, so a `verified:false` that fires unconditionally is caught.
		const acp = session();
		await acp.start();

		child.setHandler("session/set_config_option", () => ({
			configOptions: [],
		}));
		child.setHandler("session/resume", () => ({
			configOptions: [
				{
					id: "model",
					name: "Model",
					type: "select",
					currentValue: "claude-fable-5[1m]",
					options: [
						{ value: "default", name: "Default" },
						{ value: "claude-fable-5[1m]", name: "Fable" },
					],
				},
			] as SessionConfigOption[],
		}));

		await acp.setConfigOption("model", "claude-fable-5[1m]");
		const readBack = await acp.resume();

		expect(readBack.find((option) => option.id === "model")?.currentValue).toBe(
			"claude-fable-5[1m]",
		);

		await acp.dispose();
	});
});

// =============================================================================
// D1 — the widened option shape
// =============================================================================

describe("normalizer carries name / description / category (D1)", () => {
	it("keeps all three through a flat select", () => {
		expect(
			toAcpConfigOption({
				id: "effort",
				name: "Thinking effort",
				description: "How long the model deliberates",
				category: "thought_level",
				type: "select",
				currentValue: "medium",
				options: [
					{ value: "low", name: "Low", description: "quick" },
					{ value: "high", name: "High" },
				],
			}),
		).toEqual({
			id: "effort",
			name: "Thinking effort",
			description: "How long the model deliberates",
			category: "thought_level",
			values: [
				{ id: "low", label: "Low", description: "quick" },
				{ id: "high", label: "High" },
			],
			currentValue: "medium",
		});
	});

	it("omits description and category when the adapter sends neither", () => {
		const option = toAcpConfigOption({
			id: "agent",
			name: "Agent",
			type: "select",
			currentValue: "none",
			options: [{ value: "none", name: "None" }],
		});

		expect(option).not.toHaveProperty("description");
		expect(option).not.toHaveProperty("category");
	});

	it("carries them through a BOOLEAN option too", () => {
		expect(
			toAcpConfigOption({
				id: "fast",
				name: "Fast mode",
				description: "unavailable on this plan",
				category: "speed",
				type: "boolean",
				currentValue: true,
			}),
		).toEqual({
			id: "fast",
			name: "Fast mode",
			description: "unavailable on this plan",
			category: "speed",
			values: [
				{ id: "true", label: "On" },
				{ id: "false", label: "Off" },
			],
			currentValue: "true",
		});
	});

	it("flattens grouped options with 'Group / Option' labels and keeps descriptions", () => {
		expect(
			toAcpConfigOption({
				id: "model",
				name: "Model",
				type: "select",
				currentValue: "sonnet",
				// All-grouped, never mixed: `SessionConfigSelectOptions` is a union
				// of "array of options" OR "array of groups", so a list holding
				// both is not a shape the adapter can send.
				options: [
					{
						group: "anthropic",
						name: "Anthropic",
						options: [
							{ value: "sonnet", name: "Sonnet", description: "balanced" },
							{ value: "haiku", name: "Haiku" },
						],
					},
					{
						group: "other",
						name: "Other",
						options: [{ value: "default", name: "Default" }],
					},
				],
			}).values,
		).toEqual([
			{ id: "sonnet", label: "Anthropic / Sonnet", description: "balanced" },
			{ id: "haiku", label: "Anthropic / Haiku" },
			{ id: "default", label: "Other / Default" },
		]);
	});

	it("a grouped value stays writable through the gate", async () => {
		// Flattening is not cosmetic: a value the cache cannot see is a value
		// `assertValid` refuses to send.
		const grouped = new FakeAcpChild({
			configOptions: [
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
			],
		});
		const acp = new AcpSession(
			{ paneId: "pane-grouped", cwd: CWD, spawnProcess: grouped.spawnProcess },
			handlers,
		);
		await acp.start();

		await acp.setConfigOption("model", "haiku");
		expect(
			grouped.framesFor("session/set_config_option")[0]?.params?.value,
		).toBe("haiku");

		await acp.dispose();
	});
});
