import { integer, sqliteTable, text, blob, customType } from "drizzle-orm/sqlite-core";

// Custom type for Float32Array vectors stored as BLOB
const float32Vector = customType<{
	data: Float32Array;
	driverData: Buffer;
}>({
	dataType() {
		return "blob";
	},
	toDriver(value: Float32Array): Buffer {
		return Buffer.from(value.buffer);
	},
	fromDriver(value: Buffer): Float32Array {
		return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
	},
});

// Main photos table - basic file metadata only
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
});

// Perceptual hashes for duplicate detection
export const photoHashes = sqliteTable("photo_hashes", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	photoId: integer("photo_id").notNull().references(() => photos.id, { onDelete: "cascade" }),
	phash: text("phash").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// CLIP embeddings for semantic search
export const photoEmbeddings = sqliteTable("photo_embeddings", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	photoId: integer("photo_id").notNull().references(() => photos.id, { onDelete: "cascade" }),
	clipEmbedding: float32Vector("clip_embedding").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// Thumbnails for display
export const photoThumbnails = sqliteTable("photo_thumbnails", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	photoId: integer("photo_id").notNull().references(() => photos.id, { onDelete: "cascade" }),
	tiny: text("tiny").notNull(),
	small: text("small").notNull(),
	medium: text("medium").notNull(),
	large: text("large").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export type Photo = typeof photos.$inferSelect;
export type NewPhoto = typeof photos.$inferInsert;

export type PhotoHash = typeof photoHashes.$inferSelect;
export type NewPhotoHash = typeof photoHashes.$inferInsert;

export type PhotoEmbedding = typeof photoEmbeddings.$inferSelect;
export type NewPhotoEmbedding = typeof photoEmbeddings.$inferInsert;

export type PhotoThumbnail = typeof photoThumbnails.$inferSelect;
export type NewPhotoThumbnail = typeof photoThumbnails.$inferInsert;
