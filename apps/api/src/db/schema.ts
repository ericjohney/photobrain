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
	phash: text("phash"),
	clipEmbedding: float32Vector("clip_embedding"),
});

export type Photo = typeof photos.$inferSelect;
export type NewPhoto = typeof photos.$inferInsert;
