CREATE TABLE `photo_raw_previews` (
	`photo_id` integer PRIMARY KEY NOT NULL,
	`thumbnail_key` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`recipe_revision` integer NOT NULL,
	`config_key` text NOT NULL,
	`pair_photo_id` integer,
	`pair_thumbnail_key` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`error` text,
	`width` integer,
	`height` integer,
	`engine` text,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_raw_previews_pair` ON `photo_raw_previews` (`pair_photo_id`);--> statement-breakpoint
CREATE TABLE `preview_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
