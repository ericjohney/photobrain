ALTER TABLE `photo_embedding` ADD `thumbnail_key` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_root` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `source_fingerprint` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `media_version` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `thumbnail_key` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `thumbnail_root` text;--> statement-breakpoint
ALTER TABLE `photos` ADD `thumbnail_fingerprint` text;--> statement-breakpoint
ALTER TABLE `scan_items` ADD `action` text DEFAULT 'media' NOT NULL;--> statement-breakpoint
ALTER TABLE `scan_items` ADD `source_fingerprint` text;--> statement-breakpoint
ALTER TABLE `scan_items` ADD `thumbnail_key` text;--> statement-breakpoint
ALTER TABLE `scan_items` ADD `previous_thumbnail_key` text;--> statement-breakpoint
ALTER TABLE `scan_items` ADD `previous_source_fingerprint` text;--> statement-breakpoint
ALTER TABLE `scan_manifests` ADD `source_root` text;--> statement-breakpoint
ALTER TABLE `scan_manifests` ADD `thumbnails_root` text;--> statement-breakpoint
ALTER TABLE `scan_manifests` ADD `unchanged` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `scan_manifests` ADD `media` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `scan_manifests` ADD `embedding` integer DEFAULT 0 NOT NULL;