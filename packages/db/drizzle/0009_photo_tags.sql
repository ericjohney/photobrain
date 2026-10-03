CREATE TABLE `photo_tags` (
	`photo_id` integer NOT NULL,
	`tag` text NOT NULL,
	`score` real NOT NULL,
	PRIMARY KEY(`photo_id`, `tag`),
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_photo_tags_tag_photo_id` ON `photo_tags` (`tag`,`photo_id`);--> statement-breakpoint
ALTER TABLE `photo_embedding` ADD `tags_version` integer;