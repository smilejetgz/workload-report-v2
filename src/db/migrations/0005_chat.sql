CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`attachments` text,
	`proposal` text,
	`proposal_status` text,
	`apply_note` text,
	`error` text,
	`created_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_messages_thread` ON `chat_messages` (`thread_id`);--> statement-breakpoint
CREATE TABLE `chat_threads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope_key` text NOT NULL,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX `chat_threads_scope` ON `chat_threads` (`scope_key`);