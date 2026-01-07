ALTER TABLE `photos` ADD COLUMN `is_raw` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `photos` ADD COLUMN `raw_format` text;
--> statement-breakpoint
ALTER TABLE `photos` ADD COLUMN `raw_status` text;
--> statement-breakpoint
ALTER TABLE `photos` ADD COLUMN `raw_error` text;
