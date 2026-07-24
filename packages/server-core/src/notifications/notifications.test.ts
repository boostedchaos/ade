import { afterEach, describe, expect, it } from "bun:test";
import { NOTIFICATION_EVENTS } from "../constants";
import { HOOK_PROTOCOL_VERSION } from "../terminal/env";
import {
	type AgentLifecycleEvent,
	handleHookComplete,
	mapEventType,
	notificationsEmitter,
} from "./index";

const SERVER_ENV =
	process.env.NODE_ENV === "development" ? "development" : "production";

function query(params: Record<string, string>): URLSearchParams {
	return new URLSearchParams(params);
}

/** Capture the next AGENT_LIFECYCLE event (or null if none fires this call). */
function withLifecycleCapture(fn: () => void): AgentLifecycleEvent | null {
	let captured: AgentLifecycleEvent | null = null;
	const handler = (e: AgentLifecycleEvent) => {
		captured = e;
	};
	notificationsEmitter.on(NOTIFICATION_EVENTS.AGENT_LIFECYCLE, handler);
	try {
		fn();
	} finally {
		notificationsEmitter.off(NOTIFICATION_EVENTS.AGENT_LIFECYCLE, handler);
	}
	return captured;
}

afterEach(() => {
	notificationsEmitter.removeAllListeners();
});

describe("mapEventType", () => {
	it("maps start-like events to Start", () => {
		for (const raw of [
			"Start",
			"UserPromptSubmit",
			"PostToolUse",
			"sessionStart",
		]) {
			expect(mapEventType(raw)).toBe("Start");
		}
	});

	it("maps stop-like events to Stop", () => {
		for (const raw of ["Stop", "agent-turn-complete", "sessionEnd"]) {
			expect(mapEventType(raw)).toBe("Stop");
		}
	});

	it("maps permission events to PermissionRequest", () => {
		expect(mapEventType("PermissionRequest")).toBe("PermissionRequest");
		expect(mapEventType("preToolUse")).toBe("PermissionRequest");
	});

	it("returns null for unknown or missing events", () => {
		expect(mapEventType(undefined)).toBeNull();
		expect(mapEventType("")).toBeNull();
		expect(mapEventType("SomethingElse")).toBeNull();
	});
});

describe("handleHookComplete", () => {
	it("emits AGENT_LIFECYCLE with passed-through ids on a Stop event", () => {
		const event = withLifecycleCapture(() => {
			const result = handleHookComplete(
				query({
					eventType: "Stop",
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					env: SERVER_ENV,
					version: HOOK_PROTOCOL_VERSION,
				}),
			);
			expect(result.status).toBe(200);
			expect(result.body.success).toBe(true);
			expect(result.body.paneId).toBe("pane-1");
		});

		expect(event).not.toBeNull();
		expect(event).toEqual({
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			eventType: "Stop",
		});
	});

	it("normalizes a Codex agent-turn-complete into Stop", () => {
		const event = withLifecycleCapture(() => {
			handleHookComplete(
				query({ eventType: "agent-turn-complete", paneId: "p" }),
			);
		});
		expect(event?.eventType).toBe("Stop");
	});

	it("maps UserPromptSubmit to Start", () => {
		const event = withLifecycleCapture(() => {
			handleHookComplete(query({ eventType: "UserPromptSubmit", paneId: "p" }));
		});
		expect(event?.eventType).toBe("Start");
	});

	it("does not emit for an unknown eventType but still returns success", () => {
		const event = withLifecycleCapture(() => {
			const result = handleHookComplete(query({ eventType: "Bogus" }));
			expect(result.status).toBe(200);
			expect(result.body).toEqual({ success: true, ignored: true });
		});
		expect(event).toBeNull();
	});

	it("does not emit when eventType is missing", () => {
		const event = withLifecycleCapture(() => {
			const result = handleHookComplete(query({ paneId: "p" }));
			expect(result.body).toEqual({ success: true, ignored: true });
		});
		expect(event).toBeNull();
	});

	it("drops events from a mismatched environment", () => {
		const otherEnv = SERVER_ENV === "production" ? "development" : "production";
		const event = withLifecycleCapture(() => {
			const result = handleHookComplete(
				query({ eventType: "Stop", paneId: "p", env: otherEnv }),
			);
			expect(result.body.ignored).toBe(true);
			expect(result.body.reason).toBe("env_mismatch");
		});
		expect(event).toBeNull();
	});

	it("still processes when env is omitted (no cross-talk check)", () => {
		const event = withLifecycleCapture(() => {
			handleHookComplete(query({ eventType: "Stop", paneId: "p" }));
		});
		expect(event?.eventType).toBe("Stop");
	});
});
