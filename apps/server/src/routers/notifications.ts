import { NOTIFICATION_EVENTS } from "@ade/server-core/constants";
import {
	type AgentLifecycleEvent,
	notificationsEmitter,
} from "@ade/server-core/notifications";
import { observable } from "@trpc/server/observable";
import { authedProcedure, router } from "../trpc";

/**
 * Mirrors the desktop `notifications` router path
 * (apps/desktop/src/lib/trpc/routers/notifications.ts): the web renderer's
 * `useAgentHookListener` subscribes to `notifications.subscribe` as its single
 * event source. Events originate from the hook receiver
 * (@ade/server-core/notifications) that agent CLI hooks curl.
 *
 * The server only produces AGENT_LIFECYCLE events (agent Start/Stop/
 * PermissionRequest). The desktop's other kinds (FOCUS_TAB, TERMINAL_EXIT,
 * AGENT_INVOKE) are Electron-main concerns and have no server-side source, so
 * they are not wired here.
 */
type NotificationEvent = {
	type: typeof NOTIFICATION_EVENTS.AGENT_LIFECYCLE;
	data?: AgentLifecycleEvent;
};

export const notificationsRouter = router({
	subscribe: authedProcedure.subscription(() =>
		observable<NotificationEvent>((emit) => {
			const onLifecycle = (data: AgentLifecycleEvent) => {
				emit.next({ type: NOTIFICATION_EVENTS.AGENT_LIFECYCLE, data });
			};

			notificationsEmitter.on(NOTIFICATION_EVENTS.AGENT_LIFECYCLE, onLifecycle);

			return () => {
				notificationsEmitter.off(
					NOTIFICATION_EVENTS.AGENT_LIFECYCLE,
					onLifecycle,
				);
			};
		}),
	),
});
