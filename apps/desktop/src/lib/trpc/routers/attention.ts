import { observable } from "@trpc/server/observable";
import {
	listNotifications,
	markAllRead,
	markRead,
	onAttentionChanged,
	unreadAttentionByPane,
} from "main/lib/attention";
import { z } from "zod";
import { publicProcedure, router } from "..";

/**
 * Renderer's view of the attention inbox (Mission Control Feature 3).
 *
 * Query + subscription-driven invalidation, matching the notifications router
 * next door: `changed` fires on every write in main, the renderer invalidates
 * `list`, and React Query refetches. The alternative — pushing the whole list
 * over the subscription — would make the socket the source of truth for state
 * that already lives in SQLite, and a dropped event would leave the badge
 * silently wrong with nothing to reconcile against.
 */
export const createAttentionRouter = () => {
	return router({
		list: publicProcedure
			.input(
				z.object({ unreadOnly: z.boolean().optional() }).optional().default({}),
			)
			.query(({ input }) => {
				const notifications = listNotifications({
					unreadOnly: input.unreadOnly,
				});
				return {
					notifications,
					unread: notifications.filter((n) => n.readAt === null).length,
					// Computed here rather than in the renderer so the "attention
					// only" rule (custom notifications never light a pane) has one
					// implementation.
					unreadAttentionByPane: unreadAttentionByPane(
						input.unreadOnly ? notifications : listNotifications(),
					),
				};
			}),

		markRead: publicProcedure
			.input(z.object({ id: z.string() }))
			.mutation(({ input }) => ({ marked: markRead(input.id) })),

		markAllRead: publicProcedure.mutation(() => ({ marked: markAllRead() })),

		changed: publicProcedure.subscription(() => {
			return observable<{ at: number }>((emit) => {
				return onAttentionChanged(() => {
					emit.next({ at: Date.now() });
				});
			});
		}),
	});
};
