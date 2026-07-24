/**
 * Headless notification types for ade-server. Mirrors the desktop's
 * `shared/notification-types.ts` event shapes so the web renderer's
 * `notifications.subscribe` handler (useAgentHookListener) consumes identical
 * payloads whether it's talking to the Electron main process or the server.
 */

export interface NotificationIds {
	paneId?: string;
	tabId?: string;
	workspaceId?: string;
}

/**
 * Agent attention event fired by CLI hooks (Claude Code, Codex, …) when an
 * agent starts, finishes, or needs input. This is the only notification kind
 * the server produces — it is what drives the web `WebNotifier` (Stop →
 * "Agent Complete", PermissionRequest → "Input Needed").
 */
export interface AgentLifecycleEvent extends NotificationIds {
	eventType: "Start" | "Stop" | "PermissionRequest";
}
