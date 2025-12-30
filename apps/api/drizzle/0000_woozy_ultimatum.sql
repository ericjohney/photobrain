CREATE TABLE `photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`modified_at` integer NOT NULL,
	`width` integer,
	`height` integer,
	`mime_type` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photos_path_unique` ON `photos` (`path`);