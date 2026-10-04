DROP INDEX `idx_photos_pair_stem`;--> statement-breakpoint
ALTER TABLE `photos` ADD `media_type` text DEFAULT 'photo' NOT NULL;--> statement-breakpoint
ALTER TABLE `photos` ADD `duration_ms` integer;--> statement-breakpoint
ALTER TABLE `photos` ADD `video_codec` text;--> statement-breakpoint
CREATE INDEX `idx_photos_media_type` ON `photos` (`media_type`);--> statement-breakpoint
CREATE INDEX `idx_photos_pair_stem` ON `photos` (lower(substr("path", 1, length(rtrim("path", replace("path", '.', ''))) - 1)),`media_type`,`is_raw`,`duration_ms`,`path`);