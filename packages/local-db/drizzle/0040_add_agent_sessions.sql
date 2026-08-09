CREATE TABLE `agent_sessions` (
	`surface_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`agent_kind` text DEFAULT 'claude' NOT NULL,
	`session_id` text,
	`transcript_path` text,
	`state` text DEFAULT 'idle' NOT NULL,
	`pid` integer,
	`last_activity_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_sessions_workspace_id_idx` ON `agent_sessions` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `agent_sessions_state_idx` ON `agent_sessions` (`state`);