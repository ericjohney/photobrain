import { type AnyColumn, relations, type SQL, sql } from "drizzle-orm";
import {
	blob,
	check,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * RAW+JPEG pair stem: the lower-cased relative path without its final
 * extension (`2024/DSC_0001.ARW` -> `2024/dsc_0001`). The path includes the
 * folder, so only same-folder siblings share a stem. `idx_photos_pair_stem`
 * indexes exactly this expression, followed by the `media_type`, `is_raw`,
 * `duration_ms` and `path` columns the RAW pair and Live Photo lookups (and
 * the motion-clip-excluding folder scan) read, so none of them touches the
 * table. Queries must build the expression with this function (on any alias
 * of `photos.path`) for SQLite to match it.
 */
export function pairStem(path: SQL | AnyColumn): SQL {
	return sql`lower(substr(${path}, 1, length(rtrim(${path}, replace(${path}, '.', ''))) - 1))`;
}

/**
 * Capture date of an EXIF `date_taken` wall-clock text: its first 10
 * characters with `:` replaced by `-` (`2023:10:03 14:22:01` -> `2023-10-03`).
 * `idx_exif_captured_date` indexes exactly this expression; build it only
 * with this function (on any alias of `photo_exif.date_taken`) so SQLite
 * matches the index. Validity (`YYYY-MM-DD` digits, year >= 1900) is the
 * API's rule; the expression itself does not validate.
 */
export function capturedDateSql(dateTaken: SQL | AnyColumn): SQL {
	return sql`replace(substr(${dateTaken}, 1, 10), ':', '-')`;
}

/**
 * Capture month-day of an EXIF `date_taken` text (`2023:10:03 ...` ->
 * `10-03`), indexed by `idx_exif_month_day` for "On this day". Build it
 * only with this function so SQLite matches the index.
 */
export function capturedMonthDaySql(dateTaken: SQL | AnyColumn): SQL {
	return sql`replace(substr(${dateTaken}, 6, 5), ':', '-')`;
}

export const photos = sqliteTable(
	"photos",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		path: text("path").notNull().unique(),
		name: text("name").notNull(),
		size: integer("size").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
		modifiedAt: integer("modified_at", { mode: "timestamp" }).notNull(),
		width: integer("width"),
		height: integer("height"),
		mimeType: text("mime_type"),
		// Media kind: stills and videos share this table and the thumbnail path.
		mediaType: text("media_type", { enum: ["photo", "video"] })
			.notNull()
			.default("photo"),
		durationMs: integer("duration_ms"), // videos only
		videoCodec: text("video_codec"), // ffprobe codec_name ("h264", "hevc"); videos only
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
		// User curation. Scans never write these columns, so rescans preserve them.
		rating: integer("rating").notNull().default(0),
		flag: text("flag", { enum: ["pick", "reject"] }),
		// Junk review "keep": the photo never re-enters review. Scans never write it.
		junkDismissed: integer("junk_dismissed", { mode: "boolean" })
			.notNull()
			.default(false),
	},
	(table) => [
		index("idx_photos_rating").on(table.rating),
		index("idx_photos_flag").on(table.flag),
		// Junk-review candidates (junk_dismissed = 0, flag IS NULL, rating = 0)
		// in rowid order, so keyset pages need no sort.
		index("idx_photos_junk_review").on(
			table.junkDismissed,
			table.flag,
			table.rating,
		),
		index("idx_photos_media_type").on(table.mediaType),
		// Query-time RAW+JPEG pairing and Live Photo stacking look partners up by
		// stem; the trailing columns make those lookups and folder counts
		// index-only.
		index("idx_photos_pair_stem").on(
			pairStem(table.path),
			table.mediaType,
			table.isRaw,
			table.durationMs,
			table.path,
		),
		check("photos_rating_range", sql`${table.rating} BETWEEN 0 AND 5`),
		check(
			"photos_flag_values",
			sql`${table.flag} IS NULL OR ${table.flag} IN ('pick', 'reject')`,
		),
	],
);

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
		// Exact capture-date filter and "On this day" month-day lookups.
		index("idx_exif_captured_date").on(capturedDateSql(table.dateTaken)),
		index("idx_exif_month_day").on(capturedMonthDaySql(table.dateTaken)),
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
	// TAG_VOCABULARY_VERSION used to tag this vector; null means untagged.
	tagsVersion: integer("tags_version"),
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

// Manual albums. Names are unique case-insensitively (NOCASE unique index).
export const collections = sqliteTable(
	"collections",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		name: text("name").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
	},
	(table) => [
		uniqueIndex("collections_name_nocase_unique").on(
			sql`${table.name} COLLATE NOCASE`,
		),
	],
);

// Collection membership. Deleting either a collection or a photo removes the row.
export const collectionPhotos = sqliteTable(
	"collection_photos",
	{
		collectionId: integer("collection_id")
			.notNull()
			.references(() => collections.id, { onDelete: "cascade" }),
		photoId: integer("photo_id")
			.notNull()
			.references(() => photos.id, { onDelete: "cascade" }),
		addedAt: integer("added_at", { mode: "timestamp" }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.collectionId, table.photoId] }),
		index("idx_collection_photos_photo_id").on(table.photoId),
	],
);

// Zero-shot CLIP tags (up to three per photo) derived from the stored vector.
export const photoTags = sqliteTable(
	"photo_tags",
	{
		photoId: integer("photo_id")
			.notNull()
			.references(() => photos.id, { onDelete: "cascade" }),
		tag: text("tag").notNull(),
		score: real("score").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.photoId, table.tag] }),
		index("idx_photo_tags_tag_photo_id").on(table.tag, table.photoId),
	],
);

// Thumbnail quality measured from the committed `medium` WebP generation.
export const photoQuality = sqliteTable("photo_quality", {
	photoId: integer("photo_id")
		.primaryKey()
		.references(() => photos.id, { onDelete: "cascade" }),
	// Variance of the 4-neighbour Laplacian over luma (long edge <= 512).
	sharpness: real("sharpness").notNull(),
	// Mean luma, 0-255.
	brightness: real("brightness").notNull(),
	// Committed thumbnail generation the measurement was taken from.
	thumbnailKey: text("thumbnail_key").notNull(),
	qualityVersion: integer("quality_version").notNull(),
});

// Offline place (nearest GeoNames city within 100 km) for a photo's GPS. Only
// "current" when `places_version` matches the API's dataset version and the
// exact `photo_exif` coordinate texts still equal `latitude_text`/
// `longitude_text`; readers enforce that, so stale rows never surface.
export const photoPlaces = sqliteTable(
	"photo_places",
	{
		photoId: integer("photo_id")
			.primaryKey()
			.references(() => photos.id, { onDelete: "cascade" }),
		geonameId: integer("geoname_id").notNull(),
		city: text("city").notNull(),
		region: text("region"),
		countryCode: text("country_code").notNull(),
		country: text("country").notNull(),
		latitudeText: text("latitude_text").notNull(),
		longitudeText: text("longitude_text").notNull(),
		placesVersion: integer("places_version").notNull(),
	},
	(table) => [
		index("idx_photo_places_country_photo_id").on(
			table.countryCode,
			table.photoId,
		),
		index("idx_photo_places_geoname_photo_id").on(
			table.geonameId,
			table.photoId,
		),
	],
);

// Automatically detected events (a trip day, a party), fully recomputed by the
// API's `detect-events-v1` function in one transaction. `id` is the smallest
// member photo ID, so it is stable while membership is unchanged. Times are
// EXIF wall-clock `YYYY-MM-DDTHH:MM:SS` texts (no zone), so they sort
// chronologically. The place columns are all NULL (no majority place),
// `country`/`country_code` only (country majority), or all set except an
// optional `region` (city majority). `events_version` is the detection
// algorithm version that produced the row.
export const events = sqliteTable(
	"events",
	{
		id: integer("id").primaryKey(),
		startAt: text("start_at").notNull(),
		endAt: text("end_at").notNull(),
		photoCount: integer("photo_count").notNull(),
		coverPhotoId: integer("cover_photo_id").notNull(),
		city: text("city"),
		region: text("region"),
		country: text("country"),
		countryCode: text("country_code"),
		eventsVersion: integer("events_version").notNull(),
	},
	// Newest-first listing reads this index backwards without a sort.
	(table) => [index("idx_events_start_at_id").on(table.startAt, table.id)],
);

// Event membership: the counted photos only (RAW+JPEG pairs stacked to one
// member, rejects excluded). The primary key serves the `event` filter's
// `event_id` lookups; a photo belongs to at most one event.
export const eventPhotos = sqliteTable(
	"event_photos",
	{
		eventId: integer("event_id")
			.notNull()
			.references(() => events.id, { onDelete: "cascade" }),
		photoId: integer("photo_id")
			.notNull()
			.references(() => photos.id, { onDelete: "cascade" }),
	},
	(table) => [
		primaryKey({ columns: [table.eventId, table.photoId] }),
		uniqueIndex("idx_event_photos_photo_id").on(table.photoId),
	],
);

// Saved live filter sets. `filters` is the API's canonical JSON; names are unique
// case-insensitively (NOCASE unique index), independently of collection names.
export const smartAlbums = sqliteTable(
	"smart_albums",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		name: text("name").notNull(),
		filters: text("filters").notNull(),
		query: text("query"),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
	},
	(table) => [
		uniqueIndex("smart_albums_name_nocase_unique").on(
			sql`${table.name} COLLATE NOCASE`,
		),
	],
);

// Duplicate/burst groups the user marked "not duplicates", keyed by the API's
// `${kind}:${sorted member ids}` group key. A changed membership is a new key.
export const duplicateDismissals = sqliteTable("duplicate_dismissals", {
	groupKey: text("group_key").primaryKey(),
	dismissedAt: integer("dismissed_at", { mode: "timestamp" }).notNull(),
});

// People grouped from detected faces. `name` NULL is an unnamed (automatic)
// person; the cluster step deletes unnamed people left without faces.
export const people = sqliteTable("people", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	name: text("name"),
	hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
	createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

// Faces detected in a photo's committed `large` thumbnail generation
// (`thumbnail_key`). Boxes are normalized 0..1 of the oriented thumbnail;
// `embedding` is 128 little-endian float32 values, L2-normalized.
// `assignment` 'auto' faces are owned by the cluster step; 'manual' and
// 'rejected' faces are user decisions automation never changes.
export const photoFaces = sqliteTable(
	"photo_faces",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		photoId: integer("photo_id")
			.notNull()
			.references(() => photos.id, { onDelete: "cascade" }),
		thumbnailKey: text("thumbnail_key").notNull(),
		modelVersion: text("model_version").notNull(),
		x: real("x").notNull(),
		y: real("y").notNull(),
		width: real("width").notNull(),
		height: real("height").notNull(),
		score: real("score").notNull(),
		embedding: blob("embedding").notNull(),
		personId: integer("person_id").references(() => people.id, {
			onDelete: "set null",
		}),
		assignment: text("assignment", { enum: ["auto", "manual", "rejected"] })
			.notNull()
			.default("auto"),
		createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
	},
	(table) => [
		index("idx_photo_faces_photo_id").on(table.photoId),
		// Serves the `personId` filter and per-person counts index-only.
		index("idx_photo_faces_person_photo").on(table.personId, table.photoId),
		check(
			"photo_faces_assignment_values",
			sql`${table.assignment} IN ('auto', 'manual', 'rejected')`,
		),
	],
);

// One face-detection receipt per photo: the generation and model it scanned.
// A different `thumbnail_key` or `model_version` makes the photo eligible again.
export const photoFaceScan = sqliteTable(
	"photo_face_scan",
	{
		photoId: integer("photo_id")
			.primaryKey()
			.references(() => photos.id, { onDelete: "cascade" }),
		thumbnailKey: text("thumbnail_key").notNull(),
		modelVersion: text("model_version").notNull(),
		faceCount: integer("face_count").notNull(),
		status: text("status", { enum: ["completed", "failed"] }).notNull(),
		error: text("error"),
		scannedAt: integer("scanned_at", { mode: "timestamp" }).notNull(),
	},
	(table) => [
		check(
			"photo_face_scan_status_values",
			sql`${table.status} IN ('completed', 'failed')`,
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
export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type CollectionPhoto = typeof collectionPhotos.$inferSelect;
export type NewCollectionPhoto = typeof collectionPhotos.$inferInsert;
export type PhotoTag = typeof photoTags.$inferSelect;
export type NewPhotoTag = typeof photoTags.$inferInsert;
export type PhotoQuality = typeof photoQuality.$inferSelect;
export type NewPhotoQuality = typeof photoQuality.$inferInsert;
export type PhotoPlace = typeof photoPlaces.$inferSelect;
export type NewPhotoPlace = typeof photoPlaces.$inferInsert;
export type EventRecord = typeof events.$inferSelect;
export type NewEventRecord = typeof events.$inferInsert;
export type EventPhoto = typeof eventPhotos.$inferSelect;
export type NewEventPhoto = typeof eventPhotos.$inferInsert;
export type SmartAlbum = typeof smartAlbums.$inferSelect;
export type NewSmartAlbum = typeof smartAlbums.$inferInsert;
export type DuplicateDismissal = typeof duplicateDismissals.$inferSelect;
export type NewDuplicateDismissal = typeof duplicateDismissals.$inferInsert;
export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type PhotoFace = typeof photoFaces.$inferSelect;
export type NewPhotoFace = typeof photoFaces.$inferInsert;
export type PhotoFaceScan = typeof photoFaceScan.$inferSelect;
export type NewPhotoFaceScan = typeof photoFaceScan.$inferInsert;
