-- Create new separate tables for photo analytics
CREATE TABLE `photo_hashes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer NOT NULL,
	`phash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON DELETE cascade
);--> statement-breakpoint

CREATE TABLE `photo_embeddings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer NOT NULL,
	`clip_embedding` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON DELETE cascade
);--> statement-breakpoint

CREATE TABLE `photo_thumbnails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer NOT NULL,
	`tiny` text NOT NULL,
	`small` text NOT NULL,
	`medium` text NOT NULL,
	`large` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON DELETE cascade
);--> statement-breakpoint

-- Create indexes for faster lookups
CREATE INDEX `photo_hashes_photo_id_idx` ON `photo_hashes` (`photo_id`);--> statement-breakpoint
CREATE INDEX `photo_embeddings_photo_id_idx` ON `photo_embeddings` (`photo_id`);--> statement-breakpoint
CREATE INDEX `photo_thumbnails_photo_id_idx` ON `photo_thumbnails` (`photo_id`);
