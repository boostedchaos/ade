CREATE TABLE `workspace_todos` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `workspace_todos_workspace_id_idx` ON `workspace_todos` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `workspace_todos_state_idx` ON `workspace_todos` (`state`);--> statement-breakpoint
CREATE INDEX `workspace_todos_sort_order_idx` ON `workspace_todos` (`sort_order`);--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `progress` integer;