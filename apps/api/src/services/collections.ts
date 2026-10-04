import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "../db/schema";
import {
	capturedDateSql,
	collectionPhotos,
	collections,
	photos,
} from "../db/schema";
import type { ApiDatabase } from "./photo-catalog";

export const MAX_COLLECTION_NAME_LENGTH = 100;
export const MAX_COLLECTION_PHOTO_IDS = 500;

/** The API database or one of its synchronous transactions. */
type Executor = BaseSQLiteDatabase<"sync", void, typeof schema>;

export type CollectionCover = {
	photoId: number;
	thumbnailUpdatedAt: Date | null;
};

export type Collection = {
	id: number;
	name: string;
	photoCount: number;
	cover: CollectionCover | null;
	createdAt: Date;
	updatedAt: Date;
};

export type CollectionErrorCode = "NAME_TAKEN" | "NOT_FOUND";

/** Domain failure that both transports map to their own status codes. */
export class CollectionError extends Error {
	constructor(
		readonly code: CollectionErrorCode,
		message: string,
	) {
		super(message);
		this.name = "CollectionError";
	}
}

type CollectionRow = {
	id: number;
	name: string;
	created_at: number;
	updated_at: number;
	photo_count: number;
	cover_photo_id: number | null;
	cover_thumbnail_updated_at: number | null;
};

/**
 * One statement per call regardless of collection count: membership counts and
 * covers are correlated lookups on the `(collection_id, photo_id)` primary key.
 * Memberships are joined to `photos` so rows orphaned on connections without
 * foreign-key enforcement never count or become covers. The cover is the most
 * recently added member; same-second additions break ties by insertion order
 * (`rowid` grows monotonically because new rows receive `max(rowid) + 1`).
 */
function selectCollections(database: Executor, where: SQL): Collection[] {
	const rows = database.all<CollectionRow>(sql`
		SELECT
			c.id AS id,
			c.name AS name,
			c.created_at AS created_at,
			c.updated_at AS updated_at,
			(
				SELECT count(*)
				FROM collection_photos cp
				INNER JOIN photos p ON p.id = cp.photo_id
				WHERE cp.collection_id = c.id
			) AS photo_count,
			cover.id AS cover_photo_id,
			cover.thumbnail_updated_at AS cover_thumbnail_updated_at
		FROM collections c
		LEFT JOIN photos cover ON cover.id = (
			SELECT cp.photo_id
			FROM collection_photos cp
			INNER JOIN photos p ON p.id = cp.photo_id
			WHERE cp.collection_id = c.id
			ORDER BY cp.added_at DESC, cp.rowid DESC
			LIMIT 1
		)
		WHERE ${where}
		ORDER BY c.name COLLATE NOCASE ASC, c.id ASC
	`);
	// Drizzle timestamp columns store whole seconds.
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		photoCount: row.photo_count,
		cover:
			row.cover_photo_id === null
				? null
				: {
						photoId: row.cover_photo_id,
						thumbnailUpdatedAt:
							row.cover_thumbnail_updated_at === null
								? null
								: new Date(row.cover_thumbnail_updated_at * 1000),
					},
		createdAt: new Date(row.created_at * 1000),
		updatedAt: new Date(row.updated_at * 1000),
	}));
}

function notFound(): CollectionError {
	return new CollectionError("NOT_FOUND", "Collection not found");
}

/** Trims and bounds a collection name; transports validate first, this keeps the service safe. */
export function normalizeCollectionName(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_COLLECTION_NAME_LENGTH) {
		throw new RangeError(
			`Collection name must be 1-${MAX_COLLECTION_NAME_LENGTH} characters`,
		);
	}
	return trimmed;
}

function uniquePhotoIds(
	photoIds: readonly number[],
	minimum: number,
): number[] {
	const ids = [...new Set(photoIds)];
	if (ids.length < minimum || ids.length > MAX_COLLECTION_PHOTO_IDS) {
		throw new RangeError(
			`Expected ${minimum}-${MAX_COLLECTION_PHOTO_IDS} photo IDs, received ${ids.length}`,
		);
	}
	return ids;
}

/** True when `error` (or any error in its `cause` chain) is a SQLite UNIQUE violation. */
export function isUniqueConstraintViolation(error: unknown): boolean {
	for (
		let current: unknown = error;
		current instanceof Error;
		current = current.cause
	) {
		if ("code" in current && current.code === "SQLITE_CONSTRAINT_UNIQUE") {
			return true;
		}
	}
	return false;
}

/** Runs a name write, translating the NOCASE unique index violation into NAME_TAKEN. */
function withUniqueName<T>(write: () => T): T {
	try {
		return write();
	} catch (error) {
		if (isUniqueConstraintViolation(error)) {
			throw new CollectionError(
				"NAME_TAKEN",
				"A collection with that name already exists",
			);
		}
		throw error;
	}
}

function readCollection(database: Executor, id: number): Collection {
	const [collection] = selectCollections(database, sql`c.id = ${id}`);
	if (!collection) throw notFound();
	return collection;
}

function requireCollection(database: Executor, id: number) {
	const row = database
		.select({ id: collections.id })
		.from(collections)
		.where(eq(collections.id, id))
		.get();
	if (!row) throw notFound();
}

/** Counts members that still reference an existing photo. */
function countMembers(database: Executor, collectionId: number): number {
	const [row] = database.all<{ count: number }>(sql`
		SELECT count(*) AS count
		FROM collection_photos cp
		INNER JOIN photos p ON p.id = cp.photo_id
		WHERE cp.collection_id = ${collectionId}
	`);
	return row?.count ?? 0;
}

/**
 * Inserts existing, not-yet-member photos in request order (so the last listed
 * photo becomes the cover) with one existence SELECT and one multi-row INSERT.
 * Unknown IDs and existing memberships are ignored.
 */
function insertMembers(
	database: Executor,
	collectionId: number,
	ids: readonly number[],
	addedAt: Date,
): number {
	if (ids.length === 0) return 0;
	const existing = new Set(
		database
			.select({ id: photos.id })
			.from(photos)
			.where(inArray(photos.id, [...ids]))
			.all()
			.map((row) => row.id),
	);
	const values = ids
		.filter((id) => existing.has(id))
		.map((photoId) => ({ collectionId, photoId, addedAt }));
	if (values.length === 0) return 0;
	return database
		.insert(collectionPhotos)
		.values(values)
		.onConflictDoNothing()
		.returning({ photoId: collectionPhotos.photoId })
		.all().length;
}

/** All collections sorted case-insensitively by name, in one SQL statement. */
export function listCollections(database: ApiDatabase): Collection[] {
	return selectCollections(database, sql`1`);
}

export function createCollection(
	database: ApiDatabase,
	name: string,
	photoIds: readonly number[] = [],
): Collection {
	const normalized = normalizeCollectionName(name);
	const ids = uniquePhotoIds(photoIds, 0);
	return withUniqueName(() =>
		database.transaction((tx) => {
			const now = new Date();
			const created = tx
				.insert(collections)
				.values({ name: normalized, createdAt: now, updatedAt: now })
				.returning({ id: collections.id })
				.get();
			insertMembers(tx, created.id, ids, now);
			return readCollection(tx, created.id);
		}),
	);
}

/** Renames a collection; changing only the case of its own name is allowed. */
export function renameCollection(
	database: ApiDatabase,
	id: number,
	name: string,
): Collection {
	const normalized = normalizeCollectionName(name);
	return withUniqueName(() =>
		database.transaction((tx) => {
			const updated = tx
				.update(collections)
				.set({ name: normalized, updatedAt: new Date() })
				.where(eq(collections.id, id))
				.returning({ id: collections.id })
				.get();
			if (!updated) throw notFound();
			return readCollection(tx, id);
		}),
	);
}

/**
 * Deletes a collection and its memberships. Memberships are removed explicitly so
 * the result is identical on connections without foreign-key enforcement; photos
 * and their sidecars are never touched.
 */
export function deleteCollection(database: ApiDatabase, id: number): void {
	database.transaction((tx) => {
		const deleted = tx
			.delete(collections)
			.where(eq(collections.id, id))
			.returning({ id: collections.id })
			.get();
		if (!deleted) throw notFound();
		tx.delete(collectionPhotos)
			.where(eq(collectionPhotos.collectionId, id))
			.run();
	});
}

export function addPhotosToCollection(
	database: ApiDatabase,
	collectionId: number,
	photoIds: readonly number[],
): { added: number; photoCount: number } {
	const ids = uniquePhotoIds(photoIds, 1);
	return database.transaction((tx) => {
		requireCollection(tx, collectionId);
		const now = new Date();
		const added = insertMembers(tx, collectionId, ids, now);
		if (added > 0) {
			tx.update(collections)
				.set({ updatedAt: now })
				.where(eq(collections.id, collectionId))
				.run();
		}
		return { added, photoCount: countMembers(tx, collectionId) };
	});
}

export function removePhotosFromCollection(
	database: ApiDatabase,
	collectionId: number,
	photoIds: readonly number[],
): { removed: number; photoCount: number } {
	const ids = uniquePhotoIds(photoIds, 1);
	return database.transaction((tx) => {
		requireCollection(tx, collectionId);
		const removed = tx
			.delete(collectionPhotos)
			.where(
				and(
					eq(collectionPhotos.collectionId, collectionId),
					inArray(collectionPhotos.photoId, ids),
				),
			)
			.returning({ photoId: collectionPhotos.photoId })
			.all().length;
		if (removed > 0) {
			tx.update(collections)
				.set({ updatedAt: new Date() })
				.where(eq(collections.id, collectionId))
				.run();
		}
		return { removed, photoCount: countMembers(tx, collectionId) };
	});
}

/**
 * Collection IDs (ascending) containing the photo, in one statement.
 * @returns `null` when the photo does not exist.
 */
export function collectionsForPhoto(
	database: ApiDatabase,
	photoId: number,
): { collectionIds: number[] } | null {
	const rows = database.all<{ collection_id: number | null }>(sql`
		SELECT c.id AS collection_id
		FROM photos p
		LEFT JOIN collection_photos cp ON cp.photo_id = p.id
		LEFT JOIN collections c ON c.id = cp.collection_id
		WHERE p.id = ${photoId}
		ORDER BY c.id ASC
	`);
	if (rows.length === 0) return null;
	return {
		collectionIds: rows.flatMap((row) =>
			row.collection_id === null ? [] : [row.collection_id],
		),
	};
}

/** A member's export identity: the private source root never leaves the API. */
export type CollectionMember = {
	id: number;
	name: string;
	path: string;
	sourceRoot: string | null;
	mimeType: string | null;
	mediaType: "photo" | "video";
	modifiedAt: Date;
};

export type CollectionMembers = {
	name: string;
	members: CollectionMember[];
};

/**
 * The library grid's default "captured" timeline instant as sortable
 * `YYYY-MM-DDTHH:MM:SS` wall-clock text, mirroring the clients'
 * `timelineWallClock`: the EXIF `date_taken` when its `capturedDateSql` day
 * is a real date in 1900 or later (an absent or invalid `HH:MM[:SS]` time
 * reads as midnight), otherwise `modified_at` in UTC.
 */
function capturedWallClockSql(dateTaken: SQL, modifiedAt: SQL): SQL {
	const day = capturedDateSql(dateTaken);
	const minutes = sql`substr(${dateTaken}, 12, 5)`;
	const seconds = sql`substr(${dateTaken}, 12, 8)`;
	const validMinutes = sql`(${minutes} GLOB '[0-9][0-9]:[0-9][0-9]' AND ${minutes} < '24' AND time(${minutes}) IS NOT NULL)`;
	return sql`CASE
		WHEN ${day} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
			AND ${day} >= '1900' AND date(${day}) = ${day}
		THEN ${day} || 'T' || CASE
			WHEN substr(${dateTaken}, 17, 1) = ':'
				THEN CASE WHEN ${validMinutes} AND time(${seconds}) = ${seconds} THEN ${seconds} ELSE '00:00:00' END
			WHEN ${validMinutes} THEN ${minutes} || ':00'
			ELSE '00:00:00'
		END
		ELSE strftime('%Y-%m-%dT%H:%M:%S', ${modifiedAt}, 'unixepoch')
	END`;
}

type CollectionMemberRow = {
	id: number;
	name: string;
	path: string;
	source_root: string | null;
	mime_type: string | null;
	media_type: "photo" | "video";
	modified_at: number;
};

/**
 * Every member of a collection, oldest first in the grid's default captured
 * order with the ID tiebreak. RAW+JPEG pairs and Live Photos are not stacked:
 * every member file is listed, including a motion clip added on its own.
 * Rows orphaned on connections without foreign-key enforcement are excluded,
 * as in the member counts.
 * @throws CollectionError `NOT_FOUND` when the collection does not exist.
 */
export function listCollectionMembers(
	database: ApiDatabase,
	collectionId: number,
): CollectionMembers {
	return database.transaction((tx) => {
		const collection = tx
			.select({ name: collections.name })
			.from(collections)
			.where(eq(collections.id, collectionId))
			.get();
		if (!collection) throw notFound();
		const rows = tx.all<CollectionMemberRow>(sql`
			SELECT p.id AS id, p.name AS name, p.path AS path,
				p.source_root AS source_root, p.mime_type AS mime_type, p.media_type AS media_type,
				p.modified_at AS modified_at
			FROM collection_photos cp
			INNER JOIN photos p ON p.id = cp.photo_id
			LEFT JOIN photo_exif e ON e.photo_id = p.id
			WHERE cp.collection_id = ${collectionId}
			ORDER BY ${capturedWallClockSql(sql`e.date_taken`, sql`p.modified_at`)} ASC, p.id ASC
		`);
		return {
			name: collection.name,
			members: rows.map((row) => ({
				id: row.id,
				name: row.name,
				path: row.path,
				sourceRoot: row.source_root,
				mimeType: row.mime_type,
				mediaType: row.media_type,
				// Drizzle timestamp columns store whole seconds.
				modifiedAt: new Date(row.modified_at * 1000),
			})),
		};
	});
}
