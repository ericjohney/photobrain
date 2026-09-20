import { relations } from "drizzle-orm";
import {
	blob,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

export const photos = sqliteTable("photos", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	path: text("path").notNull().unique(),
	name: text("name").notNull(),
	size: integer("size").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	modifiedAt: integer("modified_at", { mode: "timestamp" }).notNull(),
	width: integer("width"),
	height: integer("height"),
	mimeType: text("mime_type"),
	// RAW file support
	isRaw: integer("is_raw", { mode: "boolean" }).default(false),
	rawFormat: text("raw_format"), // "CR2", "NEF", "ARW", etc.
	rawStatus: text("raw_status"), // "converted", "failed", "no_converter"
	rawError: text("raw_error"), // Error message if conversion failed
	// Processing status columns
	thumbnailStatus: text("thumbnail_status").default("pending"),
	thumbnailUpdatedAt: integer("thumbnail_updated_at", { mode: "timestamp" }),
	embeddingStatus: text("embedding_status").default("pending"),
	phashStatus: text("phash_status").default("pending"),
	// Precise identity and the committed thumbnail generation used by incremental scans.
	sourceRoot: text("source_root"),
	sourceFingerprint: text("source_fingerprint"),
	mediaVersion: text("media_version"),
	thumbnailKey: text("thumbnail_key"),
	thumbnailRoot: text("thumbnail_root"),
	thumbnailFingerprint: text("thumbnail_fingerprint"),
});

export const photoExif = sqliteTable(
	"photo_exif",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		photoId: integer("photo_id")
			.notNull()
			.unique()
			.references(() => photos.id, { onDelete: "cascade" }),

		// Camera info
		cameraMake: text("camera_make"),
		cameraModel: text("camera_model"),

		// Lens info
		lensMake: text("lens_make"),
		lensModel: text("lens_model"),
		focalLength: integer("focal_length"), // in mm

		// Exposure settings
		iso: integer("iso"),
		aperture: text("aperture"), // e.g., "f/2.8"
		shutterSpeed: text("shutter_speed"), // e.g., "1/250"
		exposureBias: text("exposure_bias"), // e.g., "+0.3 EV"

		// DateTime
		dateTaken: text("date_taken"), // ISO 8601 format

		// GPS coordinates
		gpsLatitude: text("gps_latitude"), // stored as text for precision
		gpsLongitude: text("gps_longitude"),
		gpsAltitude: text("gps_altitude"),
	},
	(table) => [
		index("idx_exif_camera_make").on(table.cameraMake),
		index("idx_exif_camera_model").on(table.cameraModel),
		index("idx_exif_lens_model").on(table.lensModel),
		index("idx_exif_iso").on(table.iso),
		index("idx_exif_date_taken").on(table.dateTaken),
	],
);

// Define relations
export const photosRelations = relations(photos, ({ one }) => ({
	exif: one(photoExif, {
		fields: [photos.id],
		references: [photoExif.photoId],
	}),
}));

export const photoExifRelations = relations(photoExif, ({ one }) => ({
	photo: one(photos, {
		fields: [photoExif.photoId],
		references: [photos.id],
	}),
}));

// Sidecar table for CLIP embeddings
export const photoEmbedding = sqliteTable("photo_embedding", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	photoId: integer("photo_id")
		.notNull()
		.unique()
		.references(() => photos.id, { onDelete: "cascade" }),
	embedding: blob("embedding").notNull(),
	modelVersion: text("model_version").default("clip-vit-b32"),
	thumbnailKey: text("thumbnail_key"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// Sidecar table for perceptual hashes
export const photoPhash = sqliteTable("photo_phash", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	photoId: integer("photo_id")
		.notNull()
		.unique()
		.references(() => photos.id, { onDelete: "cascade" }),
	hash: text("hash").notNull(),
	algorithm: text("algorithm").default("double_gradient_8x8"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const scanJobs = sqliteTable("scan_jobs", {
	id: text("id").primaryKey(),
	phase: text("phase").notNull().default("queued"),
	current: integer("current").notNull().default(0),
	total: integer("total").notNull().default(0),
	status: text("status").notNull().default("queued"),
	error: text("error"),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const scanManifests = sqliteTable("scan_manifests", {
	jobId: text("job_id")
		.primaryKey()
		.references(() => scanJobs.id, { onDelete: "cascade" }),
	total: integer("total").notNull(),
	processed: integer("processed").notNull().default(0),
	successful: integer("successful").notNull().default(0),
	sourceRoot: text("source_root"),
	thumbnailsRoot: text("thumbnails_root"),
	unchanged: integer("unchanged").notNull().default(0),
	media: integer("media").notNull().default(0),
	embedding: integer("embedding").notNull().default(0),
});

export const scanItems = sqliteTable(
	"scan_items",
	{
		jobId: text("job_id")
			.notNull()
			.references(() => scanManifests.jobId, { onDelete: "cascade" }),
		ordinal: integer("ordinal").notNull(),
		filePath: text("file_path").notNull(),
		relativePath: text("relative_path").notNull(),
		// An output attempt has its own key; obsolete workers cannot publish over it.
		action: text("action").notNull().default("media"),
		sourceFingerprint: text("source_fingerprint"),
		thumbnailKey: text("thumbnail_key"),
		previousThumbnailKey: text("previous_thumbnail_key"),
		previousSourceFingerprint: text("previous_source_fingerprint"),
		status: text("status").notNull().default("pending"),
		photoId: integer("photo_id"),
		error: text("error"),
	},
	(table) => [
		primaryKey({ columns: [table.jobId, table.ordinal] }),
		index("scan_items_job_status_ordinal_idx").on(
			table.jobId,
			table.status,
			table.ordinal,
		),
	],
);

// Relations for photo_embedding
export const photoEmbeddingRelations = relations(photoEmbedding, ({ one }) => ({
	photo: one(photos, {
		fields: [photoEmbedding.photoId],
		references: [photos.id],
	}),
}));

// Relations for photo_phash
export const photoPhashRelations = relations(photoPhash, ({ one }) => ({
	photo: one(photos, {
		fields: [photoPhash.photoId],
		references: [photos.id],
	}),
}));

export type Photo = typeof photos.$inferSelect;
export type NewPhoto = typeof photos.$inferInsert;
export type PhotoExif = typeof photoExif.$inferSelect;
export type NewPhotoExif = typeof photoExif.$inferInsert;
export type PhotoEmbedding = typeof photoEmbedding.$inferSelect;
export type NewPhotoEmbedding = typeof photoEmbedding.$inferInsert;
export type PhotoPhash = typeof photoPhash.$inferSelect;
export type NewPhotoPhash = typeof photoPhash.$inferInsert;
export type ScanJob = typeof scanJobs.$inferSelect;
export type NewScanJob = typeof scanJobs.$inferInsert;
export type ScanManifest = typeof scanManifests.$inferSelect;
export type NewScanManifest = typeof scanManifests.$inferInsert;
export type ScanItem = typeof scanItems.$inferSelect;
export type NewScanItem = typeof scanItems.$inferInsert;
