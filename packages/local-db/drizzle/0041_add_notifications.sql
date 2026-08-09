CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'attention' NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`pane_id` text,
	`workspace_id` text,
	`created_at` integer NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
CREATE INDEX `notifications_created_at_idx` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_read_at_idx` ON `notifications` (`read_at`);--> statement-breakpoint
CREATE INDEX `notifications_pane_id_idx` ON `notifications` (`pane_id`);