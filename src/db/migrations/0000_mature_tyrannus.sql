CREATE TABLE `ai_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`date` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`prompt` text NOT NULL,
	`raw_output` text,
	`duration_ms` integer,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_calls_run` ON `ai_calls` (`run_id`);--> statement-breakpoint
CREATE TABLE `card_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`snapshot` text NOT NULL,
	`reason` text,
	`created_at` integer,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `card_versions_card` ON `card_versions` (`card_id`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer,
	`tasks_date` text NOT NULL,
	`duration_sec` integer NOT NULL,
	`topic` text DEFAULT '' NOT NULL,
	`note_html` text DEFAULT '' NOT NULL,
	`task_type` text NOT NULL,
	`website` text,
	`clickup_task` text,
	`origin` text DEFAULT 'git' NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`evidence` text DEFAULT '{"commits":[],"tasks":[]}' NOT NULL,
	`time_of_day` text,
	`fingerprint` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`remote_task_id` text,
	`error` text,
	`internal_note` text DEFAULT '' NOT NULL,
	`approved_at` integer,
	`submitted_at` integer,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cards_date` ON `cards` (`tasks_date`);--> statement-breakpoint
CREATE INDEX `cards_fingerprint` ON `cards` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `clickup_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`at` integer NOT NULL,
	`actor_id` text,
	`text` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clickup_events_task_kind_at` ON `clickup_events` (`task_id`,`kind`,`at`);--> statement-breakpoint
CREATE INDEX `clickup_events_at` ON `clickup_events` (`at`);--> statement-breakpoint
CREATE TABLE `clickup_tasks` (
	`task_id` text PRIMARY KEY NOT NULL,
	`custom_id` text,
	`name` text NOT NULL,
	`status` text,
	`status_type` text,
	`list_name` text,
	`folder_name` text,
	`space_name` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`assignees` text DEFAULT '[]' NOT NULL,
	`url` text,
	`date_created` integer,
	`date_updated` integer,
	`date_closed` integer,
	`due_date` integer,
	`priority` text,
	`description` text,
	`synced_at` integer
);
--> statement-breakpoint
CREATE TABLE `commit_task_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`commit_hash` text NOT NULL,
	`project_id` integer NOT NULL,
	`task_id` text NOT NULL,
	`source` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commit_task_links_unique` ON `commit_task_links` (`commit_hash`,`project_id`,`task_id`);--> statement-breakpoint
CREATE TABLE `commits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`hash` text NOT NULL,
	`author_date` integer NOT NULL,
	`author_email` text NOT NULL,
	`author_name` text NOT NULL,
	`message` text NOT NULL,
	`branch` text,
	`ticket_ids` text DEFAULT '[]' NOT NULL,
	`files_summary` text,
	`insertions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`files_changed` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `commits_project_hash` ON `commits` (`project_id`,`hash`);--> statement-breakpoint
CREATE INDEX `commits_author_date` ON `commits` (`author_date`);--> statement-breakpoint
CREATE TABLE `day_targets` (
	`date` text PRIMARY KEY NOT NULL,
	`target_sec` integer NOT NULL,
	`kind` text DEFAULT 'workday' NOT NULL,
	`note` text,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`author_email_filter` text,
	`default_task_type` text,
	`default_website` text,
	`last_scanned_at` integer,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`progress` text,
	`error` text,
	`heartbeat_at` integer,
	`created_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `style_examples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tasks_date` text NOT NULL,
	`task_type` text NOT NULL,
	`duration_sec` integer NOT NULL,
	`note_html` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `task_types` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`synced_at` integer
);
