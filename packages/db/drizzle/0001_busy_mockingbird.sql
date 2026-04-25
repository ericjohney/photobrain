CREATE INDEX `idx_exif_camera_make` ON `photo_exif` (`camera_make`);--> statement-breakpoint
CREATE INDEX `idx_exif_camera_model` ON `photo_exif` (`camera_model`);--> statement-breakpoint
CREATE INDEX `idx_exif_lens_model` ON `photo_exif` (`lens_model`);--> statement-breakpoint
CREATE INDEX `idx_exif_iso` ON `photo_exif` (`iso`);--> statement-breakpoint
CREATE INDEX `idx_exif_date_taken` ON `photo_exif` (`date_taken`);