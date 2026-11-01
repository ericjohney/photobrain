CREATE TABLE `photo_raw_edits` (
	`photo_id` integer PRIMARY KEY NOT NULL,
	`engine` text NOT NULL,
	`settings` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "photo_raw_edits_engine" CHECK("photo_raw_edits"."engine" IN ('apple', 'adobe')),
	CONSTRAINT "photo_raw_edits_revision" CHECK("photo_raw_edits"."revision" > 0)
);
