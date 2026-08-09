import { describe, expect, it } from "bun:test";
import { mapAgentSessionState, mapEventType } from "./map-event-type";

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
