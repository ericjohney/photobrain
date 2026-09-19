CREATE TABLE `scan_items` (
	`job_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`file_path` text NOT NULL,
	`relative_path` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`photo_id` integer,
	`error` text,
	PRIMARY KEY(`job_id`, `ordinal`),
	FOREIGN KEY (`job_id`) REFERENCES `scan_manifests`(`job_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scan_items_job_status_ordinal_idx` ON `scan_items` (`job_id`,`status`,`ordinal`);--> statement-breakpoint
CREATE TABLE `scan_manifests` (
	`job_id` text PRIMARY KEY NOT NULL,
	`total` integer NOT NULL,
	`processed` integer DEFAULT 0 NOT NULL,
	`successful` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `scan_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
