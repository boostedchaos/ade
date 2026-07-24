/**
 * Normalizes the raw `eventType` a CLI-agent hook sends into the three
 * lifecycle states the renderer understands. Ported verbatim from the desktop
 * (`main/lib/notifications/map-event-type.ts`) so hook payloads map identically
 * on the server. A single source of truth here keeps the hook script dumb — it
 * only special-cases `UserPromptSubmit`; everything else is normalized here.
 */
export function mapEventType(
	eventType: string | undefined,
): "Start" | "Stop" | "PermissionRequest" | null {
	if (!eventType) {
		return null;
	}
	if (
		eventType === "Start" ||
		eventType === "UserPromptSubmit" ||
		eventType === "PostToolUse" ||
		eventType === "PostToolUseFailure" ||
		eventType === "BeforeAgent" ||
		eventType === "AfterTool" ||
		eventType === "sessionStart" ||
		eventType === "userPromptSubmitted" ||
		eventType === "postToolUse"
	) {
		return "Start";
	}
	if (eventType === "PermissionRequest" || eventType === "preToolUse") {
		return "PermissionRequest";
	}
	if (
		eventType === "Stop" ||
		eventType === "agent-turn-complete" ||
		eventType === "AfterAgent" ||
		eventType === "sessionEnd"
	) {
		return "Stop";
	}
	return null;
}
