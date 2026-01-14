import { relations } from "drizzle-orm";
import {
	blob,
	integer,
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
	embeddingStatus: text("embedding_status").default("pending"),
	phashStatus: text("phash_status").default("pending"),
});

export const photoExif = sqliteTable("photo_exif", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	photoId: integer("photo_id")
		.notNull()
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
});

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
