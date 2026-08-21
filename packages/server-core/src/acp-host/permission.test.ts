/**
 * Permission policy: the mode mapping, the auto-approve handler, and the
 * `session/request_permission` round trip over the wire.
 *
 * Phase 0 ground truth: the adapter defaults to `bypassPermissions` and never
 * consults `canUseTool` in that mode, so the policy has to move the MODE. The
 * handler is wired anyway, defensively — these tests cover both halves.
 */
import { describe, expect, it } from "bun:test";
import type { SessionModeState } from "@agentclientprotocol/sdk";
import { AcpSession } from "./acp-session";
import { setAcpBinaryPathResolver } from "./binary-resolver";
import {
	FakeAcpChild,
	FIXTURE_MODES,
	FIXTURE_SESSION_ID,
} from "./fake-acp-child";
import {
	autoApprovePermissionHandler,
	BYPASS_PERMISSIONS_MODE_ID,
	resolveModeIdForPolicy,
} from "./permission";
import type { AcpPermissionRequest } from "./types";

setAcpBinaryPathResolver(() => "/fake/claude-agent-acp/index.js");

describe("resolveModeIdForPolicy", () => {
	it("picks bypassPermissions for auto-approve", () => {
		expect(resolveModeIdForPolicy("auto-approve", FIXTURE_MODES)).toBe(
			BYPASS_PERMISSIONS_MODE_ID,
		);
	});

	it("picks the first non-bypass mode for prompt", () => {
		expect(resolveModeIdForPolicy("prompt", FIXTURE_MODES)).toBe("default");
	});

	it("returns null when the mode it needs is not offered", () => {
		const onlyDefault: SessionModeState = {
			currentModeId: "default",
			availableModes: [{ id: "default", name: "Default" }],
		};
		expect(resolveModeIdForPolicy("auto-approve", onlyDefault)).toBeNull();

		const onlyBypass: SessionModeState = {
			currentModeId: BYPASS_PERMISSIONS_MODE_ID,
			availableModes: [
				{ id: BYPASS_PERMISSIONS_MODE_ID, name: "Bypass Permissions" },
			],
		};
		expect(resolveModeIdForPolicy("prompt", onlyBypass)).toBeNull();
	});

	it("returns null when session/new offered no modes at all", () => {
		expect(resolveModeIdForPolicy("auto-approve", null)).toBeNull();
		expect(resolveModeIdForPolicy("auto-approve", undefined)).toBeNull();
	});
});

describe("autoApprovePermissionHandler", () => {
	function request(
		options: AcpPermissionRequest["options"],
	): AcpPermissionRequest {
		return {
			sessionId: FIXTURE_SESSION_ID,
			toolCall: { toolCallId: "tool-1", title: "Write file" },
			options,
		};
	}

	it("selects an allow option", async () => {
		expect(
			await autoApprovePermissionHandler(
				request([
					{ optionId: "reject", name: "Reject", kind: "reject_once" },
					{ optionId: "allow", name: "Allow", kind: "allow_once" },
				]),
			),
		).toEqual({ outcome: "selected", optionId: "allow" });
	});

	it("prefers an allow option over the first option offered", async () => {
		expect(
			await autoApprovePermissionHandler(
				request([
					{ optionId: "reject-always", name: "No", kind: "reject_always" },
					{ optionId: "allow-always", name: "Always", kind: "allow_always" },
				]),
			),
		).toEqual({ outcome: "selected", optionId: "allow-always" });
	});

	it("falls back to the first option when none is an allow", async () => {
		expect(
			await autoApprovePermissionHandler(
				request([{ optionId: "reject-once", name: "No", kind: "reject_once" }]),
			),
		).toEqual({ outcome: "selected", optionId: "reject-once" });
	});

	it("cancels rather than guessing when no options are offered", async () => {
		expect(await autoApprovePermissionHandler(request([]))).toEqual({
			outcome: "cancelled",
		});
	});
});

describe("session/request_permission over the wire", () => {
	it("answers an agent permission request with an approval", async () => {
		const child = new FakeAcpChild();
		const session = new AcpSession(
			{
				paneId: "pane-permission",
				cwd: process.cwd(),
				spawnProcess: child.spawnProcess,
			},
			{ onUpdate: () => {}, onError: () => {}, onExit: () => {} },
		);
		await session.start();

		const outcome = await child.request("session/request_permission", {
			sessionId: FIXTURE_SESSION_ID,
			toolCall: { toolCallId: "tool-7", title: "Edit a file" },
			options: [
				{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
				{ optionId: "allow-once", name: "Allow", kind: "allow_once" },
			],
		});

		expect(outcome).toEqual({
			outcome: { outcome: "selected", optionId: "allow-once" },
		});

		await session.dispose();
	});
});
