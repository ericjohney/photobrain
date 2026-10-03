-- drizzle-kit generated a full `photos` table rebuild for the CHECK constraints. That rebuild
-- cannot run inside the migrator transaction (PRAGMA foreign_keys is a no-op there, so the
-- DROP would cascade into photo_exif/photo_embedding/photo_phash where enforcement is on).
-- SQLite accepts column-level CHECK constraints on ADD COLUMN, so existing rows keep their
-- identity and sidecars and receive rating 0 / flag NULL.
ALTER TABLE `photos` ADD `rating` integer DEFAULT 0 NOT NULL CONSTRAINT `photos_rating_range` CHECK(`rating` BETWEEN 0 AND 5);--> statement-breakpoint
ALTER TABLE `photos` ADD `flag` text CONSTRAINT `photos_flag_values` CHECK(`flag` IS NULL OR `flag` IN ('pick', 'reject'));--> statement-breakpoint
CREATE INDEX `idx_photos_rating` ON `photos` (`rating`);--> statement-breakpoint
CREATE INDEX `idx_photos_flag` ON `photos` (`flag`);
