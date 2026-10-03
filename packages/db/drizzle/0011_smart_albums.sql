CREATE TABLE `smart_albums` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`filters` text NOT NULL,
	`query` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `smart_albums_name_nocase_unique` ON `smart_albums` ("name" COLLATE NOCASE);