CREATE TABLE `event_photos` (
	`event_id` integer NOT NULL,
	`photo_id` integer NOT NULL,
	PRIMARY KEY(`event_id`, `photo_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_event_photos_photo_id` ON `event_photos` (`photo_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`photo_count` integer NOT NULL,
	`cover_photo_id` integer NOT NULL,
	`city` text,
	`region` text,
	`country` text,
	`country_code` text,
	`events_version` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_start_at_id` ON `events` (`start_at`,`id`);