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
