CREATE TABLE `scan_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`phase` text DEFAULT 'queued' NOT NULL,
	`current` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
