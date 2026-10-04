CREATE TABLE `people` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text,
	`hidden` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `photo_face_scan` (
	`photo_id` integer PRIMARY KEY NOT NULL,
	`thumbnail_key` text NOT NULL,
	`model_version` text NOT NULL,
	`face_count` integer NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`scanned_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "photo_face_scan_status_values" CHECK("photo_face_scan"."status" IN ('completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `photo_faces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`photo_id` integer NOT NULL,
	`thumbnail_key` text NOT NULL,
	`model_version` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`width` real NOT NULL,
	`height` real NOT NULL,
	`score` real NOT NULL,
	`embedding` blob NOT NULL,
	`person_id` integer,
	`assignment` text DEFAULT 'auto' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`photo_id`) REFERENCES `photos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "photo_faces_assignment_values" CHECK("photo_faces"."assignment" IN ('auto', 'manual', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `idx_photo_faces_photo_id` ON `photo_faces` (`photo_id`);--> statement-breakpoint
CREATE INDEX `idx_photo_faces_person_photo` ON `photo_faces` (`person_id`,`photo_id`);