CREATE TABLE `photo_quality` (
	`photo_id` integer PRIMARY KEY NOT NULL,
	`sharpness` real NOT NULL,
	`brightness` real NOT NULL,
	`thumbnail_key` text NOT NULL,
	`quality_version` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `photos` ADD `junk_dismissed` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_photos_junk_review` ON `photos` (`junk_dismissed`,`flag`,`rating`);