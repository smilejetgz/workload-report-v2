ALTER TABLE `ai_calls` ADD `model` text;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `cache_creation_tokens` integer;--> statement-breakpoint
ALTER TABLE `ai_calls` ADD `cost_usd` real;