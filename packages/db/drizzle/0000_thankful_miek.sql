CREATE TABLE `photo_embedding` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer NOT NULL,
	`embedding` blob NOT NULL,
	`model_version` text DEFAULT 'clip-vit-b32',
	`created_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photo_embedding_photo_id_unique` ON `photo_embedding` (`photo_id`);--> statement-breakpoint
CREATE TABLE `photo_exif` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer NOT NULL,
	`camera_make` text,
	`camera_model` text,
	`lens_make` text,
	`lens_model` text,
	`focal_length` integer,
	`iso` integer,
	`aperture` text,
	`shutter_speed` text,
	`exposure_bias` text,
	`date_taken` text,
	`gps_latitude` text,
	`gps_longitude` text,
	`gps_altitude` text,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photo_exif_photo_id_unique` ON `photo_exif` (`photo_id`);--> statement-breakpoint
CREATE TABLE `photo_phash` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer NOT NULL,
	`hash` text NOT NULL,
	`algorithm` text DEFAULT 'double_gradient_8x8',
	`created_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photo_phash_photo_id_unique` ON `photo_phash` (`photo_id`);--> statement-breakpoint
CREATE TABLE `photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`modified_at` integer NOT NULL,
	`width` integer,
	`height` integer,
	`mime_type` text,
	`is_raw` integer DEFAULT false,
	`raw_format` text,
	`raw_status` text,
	`raw_error` text,
	`thumbnail_status` text DEFAULT 'pending',
	`embedding_status` text DEFAULT 'pending',
	`phash_status` text DEFAULT 'pending'
);
--> statement-breakpoint
CREATE UNIQUE INDEX `photos_path_unique` ON `photos` (`path`);