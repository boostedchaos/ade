import { describe, expect, it } from "bun:test";
import {
	classifyNotificationMessage,
	mapAgentSessionState,
	mapEventType,
} from "./map-event-type";

describe("mapAgentSessionState", () => {
	it("covers the spec's full Claude Code event set", () => {
		expect(mapAgentSessionState("SessionStart")).toBe("idle");
		expect(mapAgentSessionState("UserPromptSubmit")).toBe("working");
		expect(mapAgentSessionState("PreToolUse")).toBe("working");
		expect(mapAgentSessionState("PostToolUse")).toBe("working");
		expect(mapAgentSessionState("Notification")).toBe("needsInput");
		expect(mapAgentSessionState("PermissionRequest")).toBe("needsInput");
		expect(mapAgentSessionState("Stop")).toBe("idle");
		expect(mapAgentSessionState("SessionEnd")).toBe("ended");
	});

	it("returns null for unknown and missing events", () => {
		expect(mapAgentSessionState(undefined)).toBeNull();
		expect(mapAgentSessionState("")).toBeNull();
		expect(mapAgentSessionState("SomethingNew")).toBeNull();
	});

	it("still understands the camelCase spellings other agent CLIs send", () => {
		expect(mapAgentSessionState("sessionStart")).toBe("idle");
		expect(mapAgentSessionState("postToolUse")).toBe("working");
		expect(mapAgentSessionState("agent-turn-complete")).toBe("idle");
		expect(mapAgentSessionState("sessionEnd")).toBe("ended");
	});
});

describe("mapEventType", () => {
	it("keeps its three-value contract with the renderer", () => {
		expect(mapEventType("UserPromptSubmit")).toBe("Start");
		expect(mapEventType("PostToolUse")).toBe("Start");
		expect(mapEventType("PermissionRequest")).toBe("PermissionRequest");
		expect(mapEventType("Stop")).toBe("Stop");
		expect(mapEventType(undefined)).toBeNull();
		expect(mapEventType("Nope")).toBeNull();
	});

	it("maps Claude's Notification to a permission prompt", () => {
		expect(mapEventType("Notification")).toBe("PermissionRequest");
	});

	it("treats PreToolUse as work, not as a permission prompt", () => {
		// Claude fires PreToolUse for every tool call, permitted or not; reading
		// it as needsInput would leave panes waiting on input nobody asked for.
		expect(mapEventType("PreToolUse")).toBe("Start");
		expect(mapAgentSessionState("PreToolUse")).toBe("working");
	});

	it("leaves SessionStart with no PaneStatus meaning", () => {
		// It moves the session record to idle, but must not repaint the pane —
		// only mapAgentSessionState knows about it.
		expect(mapEventType("SessionStart")).toBeNull();
		expect(mapAgentSessionState("SessionStart")).toBe("idle");
	});

	it("keeps the opencode camelCase preToolUse as a permission prompt", () => {
		// Distinct from Claude's PascalCase PreToolUse — that spelling comes from
		// a CLI that only fires it when it actually needs approval.
		expect(mapEventType("preToolUse")).toBe("PermissionRequest");
	});
});

describe("Notification message classification", () => {
	// Claude Code fires one `Notification` event for two unrelated reasons.
	// Representative wording of each kind, as Claude Code emits it.
	const PERMISSION_MESSAGES = [
		"Claude needs your permission to use Bash",
		"Claude needs your permission to use Edit",
		"Permission required to run npm install",
		"Approve this action?",
	];
	const IDLE_MESSAGES = [
		"Claude is waiting for your input",
		"Claude is waiting for your input in /Users/x/project",
	];

	it("classifies both payload kinds", () => {
		for (const message of PERMISSION_MESSAGES) {
			expect(classifyNotificationMessage(message)).toBe("permission");
		}
		for (const message of IDLE_MESSAGES) {
			expect(classifyNotificationMessage(message)).toBe("idle");
		}
	});

	it("drops the idle nudge instead of painting an attention ring", () => {
		// The ~60s "still waiting" nudge is not an ask. Mapping it to needsInput
		// leaves a red ring and a Dock badge on every pane the user walks away
		// from, clearable only by typing. Stop already put the session in idle.
		for (const message of IDLE_MESSAGES) {
			expect(mapAgentSessionState("Notification", message)).toBeNull();
			expect(mapEventType("Notification", message)).toBeNull();
		}
	});

	it("still surfaces a real permission ask", () => {
		for (const message of PERMISSION_MESSAGES) {
			expect(mapAgentSessionState("Notification", message)).toBe("needsInput");
			expect(mapEventType("Notification", message)).toBe("PermissionRequest");
		}
	});

	it("falls back to needsInput when no message reaches us", () => {
		// A hooks file written by an older ADE forwards no `message`. Dropping
		// those would silently lose real asks, so only positively-identified
		// idle nudges are ignored.
		expect(classifyNotificationMessage(undefined)).toBe("unknown");
		expect(classifyNotificationMessage("")).toBe("unknown");
		expect(classifyNotificationMessage("something we don't recognise")).toBe(
			"unknown",
		);
		expect(mapAgentSessionState("Notification")).toBe("needsInput");
		expect(mapAgentSessionState("Notification", "")).toBe("needsInput");
		expect(mapEventType("Notification", "brand new wording")).toBe(
			"PermissionRequest",
		);
	});

	it("only qualifies Notification — other events ignore the message", () => {
		const idle = "Claude is waiting for your input";
		expect(mapAgentSessionState("PermissionRequest", idle)).toBe("needsInput");
		expect(mapAgentSessionState("Stop", idle)).toBe("idle");
		expect(mapEventType("preToolUse", idle)).toBe("PermissionRequest");
	});
});
