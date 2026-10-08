-- The app now writes to workload v2. Remote ids stored so far belong to the
-- old workload and may equal an unrelated v2 row, so they are tagged "v1:"
-- and never sent as a v2 task id; reconcile re-links them through the
-- legacyId each migrated v2 row keeps.
UPDATE `cards` SET `remote_task_id` = 'v1:' || `remote_task_id` WHERE `remote_task_id` IS NOT NULL AND `remote_task_id` NOT LIKE 'v1:%';
--> statement-breakpoint
-- Task type ids came from the old workload too; the next sync refills this from v2.
DELETE FROM `task_types`;
--> statement-breakpoint
-- The upload identity now comes from the v2 token; a v1 token cannot sign in there.
DELETE FROM `settings` WHERE `key` IN ('task_by', 'email', 'jwt');
