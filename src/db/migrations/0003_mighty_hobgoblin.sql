CREATE TABLE `workload_projects` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'website' NOT NULL,
	`website_url` text,
	`is_active` integer DEFAULT true NOT NULL,
	`synced_at` integer
);
--> statement-breakpoint
ALTER TABLE `task_types` ADD `is_active` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `task_types` ADD `is_fallback` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `task_types` ADD `form_kind` text;--> statement-breakpoint
ALTER TABLE `task_types` ADD `position_ids` text DEFAULT '[]' NOT NULL;