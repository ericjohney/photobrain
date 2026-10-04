CREATE TABLE `upload_assets` (
	`device_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`resource` text NOT NULL,
	`upload_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `asset_id`, `resource`),
	FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "upload_assets_resource_values" CHECK("upload_assets"."resource" IN ('photo', 'video', 'pairedVideo', 'alternatePhoto'))
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`relative_path` text NOT NULL,
	`device_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_sha256_unique` ON `uploads` (`sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `uploads_relative_path_unique` ON `uploads` (`relative_path`);