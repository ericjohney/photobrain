CREATE TABLE `photo_places` (
	`photo_id` integer PRIMARY KEY NOT NULL,
	`geoname_id` integer NOT NULL,
	`city` text NOT NULL,
	`region` text,
	`country_code` text NOT NULL,
	`country` text NOT NULL,
	`latitude_text` text NOT NULL,
	`longitude_text` text NOT NULL,
	`places_version` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_photo_places_country_photo_id` ON `photo_places` (`country_code`,`photo_id`);--> statement-breakpoint
CREATE INDEX `idx_photo_places_geoname_photo_id` ON `photo_places` (`geoname_id`,`photo_id`);