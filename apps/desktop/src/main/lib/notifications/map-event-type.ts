/**
 * Normalises the `eventType` a hook reports into the two vocabularies main
 * speaks.
 *
 * `mapEventType` is the older, coarser one: it feeds `AgentLifecycleEvent`,
 * which drives PaneStatus and the notification manager. Its three values are a
 * fixed contract with the renderer and are deliberately left alone.
 *
 * `mapAgentSessionState` is Mission Control Feature 2's finer one: the four
 * AgentSession states. Hooks are the authority for these — nothing here ever
 * guesses from screen text or a window title.
 */

export type AgentSessionState = "working" | "needsInput" | "idle" | "ended";

/**
 * Hook event name → AgentSession state. Covers Claude Code's PascalCase names
 * (what ADE's own hooks file registers) plus the camelCase spellings other
 * agent CLIs emit through the same receiver.
 *
 * `PreToolUse` is `working`: Claude fires it before every tool call, permitted
 * or not, so treating it as a permission prompt would leave panes stuck
 * awaiting input that was never requested. Claude's actual ask is `Notification`
 * (and `PermissionRequest` on the CLIs that send it).
 */
const SESSION_STATE_BY_EVENT: Record<string, AgentSessionState> = {
	SessionStart: "idle",
	sessionStart: "idle",
	Start: "working",
	UserPromptSubmit: "working",
	userPromptSubmitted: "working",
	PreToolUse: "working",
	PostToolUse: "working",
	postToolUse: "working",
	PostToolUseFailure: "working",
	BeforeAgent: "working",
	AfterTool: "working",
	Notification: "needsInput",
	PermissionRequest: "needsInput",
	preToolUse: "needsInput",
	Stop: "idle",
	"agent-turn-complete": "idle",
	AfterAgent: "idle",
	SessionEnd: "ended",
	sessionEnd: "ended",
};

export function mapAgentSessionState(
	eventType: string | undefined,
): AgentSessionState | null {
	if (!eventType) return null;
	return SESSION_STATE_BY_EVENT[eventType] ?? null;
}

export function mapEventType(
	eventType: string | undefined,
): "Start" | "Stop" | "PermissionRequest" | null {
	if (!eventType) {
		return null;
	}
	if (
		eventType === "Start" ||
		eventType === "UserPromptSubmit" ||
		eventType === "PreToolUse" ||
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
	if (
		eventType === "PermissionRequest" ||
		eventType === "Notification" ||
		eventType === "preToolUse"
	) {
		return "PermissionRequest";
	}
	if (
		eventType === "Stop" ||
		eventType === "agent-turn-complete" ||
		eventType === "AfterAgent" ||
		eventType === "sessionEnd" ||
		eventType === "SessionEnd"
	) {
		return "Stop";
	}
	return null;
}
