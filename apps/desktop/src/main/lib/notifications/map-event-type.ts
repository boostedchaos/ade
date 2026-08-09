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
 * What a Claude Code `Notification` payload is actually about. Claude fires
 * that one event for two unrelated reasons — a permission/approval ask, and a
 * "still waiting for you" nudge roughly a minute after a turn goes idle — and
 * only the first is `needsInput`. Treating both as an ask paints a permanent
 * red attention ring and a Dock badge on every pane the user walks away from,
 * clearable only by typing, which destroys the affordance it is meant to serve.
 * The event name cannot separate them; the `message` field can.
 */
export type NotificationKind = "permission" | "idle" | "unknown";

/** Approval-shaped wording, e.g. "Claude needs your permission to use Bash". */
const PERMISSION_MESSAGE = /permission|approv|authoriz|confirm|allow/i;

/** Nudge-shaped wording, e.g. "Claude is waiting for your input". */
const IDLE_MESSAGE = /waiting for (?:your|user)\b|is waiting\b|\bidle\b/i;

/**
 * Classifies a `Notification` message. Permission wins over idle when a
 * message somehow reads as both — a spurious ring is recoverable, a missed
 * permission ask leaves the pane silently blocked.
 *
 * `unknown` (no message forwarded, or wording we do not recognise) is
 * deliberately NOT ignored downstream: it keeps the pre-fix `needsInput`
 * behaviour, so a hooks file written by an older ADE — which forwards no
 * `message` at all — still surfaces real asks. Only positively-identified
 * idle nudges are dropped.
 */
export function classifyNotificationMessage(
	message: string | undefined,
): NotificationKind {
	if (!message) return "unknown";
	if (PERMISSION_MESSAGE.test(message)) return "permission";
	if (IDLE_MESSAGE.test(message)) return "idle";
	return "unknown";
}

/**
 * True when this event carries no attention meaning at all: a `Notification`
 * whose message is an idle nudge. `Stop` has already put the session in `idle`
 * by the time one of these arrives, so dropping it changes nothing else.
 */
function isIdleNudge(eventType: string, message: string | undefined): boolean {
	return (
		eventType === "Notification" &&
		classifyNotificationMessage(message) === "idle"
	);
}

/**
 * Hook event name → AgentSession state. Covers Claude Code's PascalCase names
 * (what ADE's own hooks file registers) plus the camelCase spellings other
 * agent CLIs emit through the same receiver.
 *
 * `PreToolUse` is `working`: Claude fires it before every tool call, permitted
 * or not, so treating it as a permission prompt would leave panes stuck
 * awaiting input that was never requested. Claude's actual ask is `Notification`
 * (and `PermissionRequest` on the CLIs that send it).
 *
 * `Notification` is qualified by its `message` — see `classifyNotificationMessage`.
 * The row below is what it means when the message is an ask or unrecognised;
 * an idle nudge is dropped before this table is consulted.
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
	message?: string,
): AgentSessionState | null {
	if (!eventType) return null;
	if (isIdleNudge(eventType, message)) return null;
	return SESSION_STATE_BY_EVENT[eventType] ?? null;
}

export function mapEventType(
	eventType: string | undefined,
	message?: string,
): "Start" | "Stop" | "PermissionRequest" | null {
	if (!eventType) {
		return null;
	}
	if (isIdleNudge(eventType, message)) {
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
