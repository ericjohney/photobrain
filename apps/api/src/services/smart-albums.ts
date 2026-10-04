import { eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "../db/schema";
import { smartAlbums } from "../db/schema";
import {
	type CollectionCover,
	isUniqueConstraintViolation,
} from "./collections";
import {
	type ApiDatabase,
	type PhotoCatalogRepresentation,
	type PhotoFilters,
	photoFilterConditions,
} from "./photo-catalog";
import { PHOTO_FLAGS } from "./photo-curation";
import { COUNTRY_CODE_PATTERN } from "./place-lookup";
import { MAX_TAG_SLUG_LENGTH, TAG_SLUG_PATTERN } from "./tag-vocabulary";

export const MAX_SMART_ALBUM_NAME_LENGTH = 100;
export const MAX_SMART_ALBUM_QUERY_LENGTH = 200;
/** Accepted `dateMonth` inputs: `YYYY-MM` or the stored-EXIF `YYYY:MM`. */
export const SMART_ALBUM_DATE_MONTH_PATTERN = /^\d{4}[-:](0[1-9]|1[0-2])$/;

/** The executor shared by the API database and its synchronous transactions. */
type Executor = BaseSQLiteDatabase<"sync", void, typeof schema>;
type SmartAlbumRow = typeof smartAlbums.$inferSelect;

/**
 * Filters as accepted from clients: the photo filters minus `collectionId` and
 * the view scopes `bounds` and `capturedDate`.
 */
export type SmartAlbumFiltersInput = Omit<
	PhotoFilters,
	"collectionId" | "bounds" | "capturedDate"
>;

/**
 * Canonical saved filters: no empty strings, no `filterRaw: "all"`, and
 * `dateMonth` as `YYYY-MM` in storage (transport representation on output).
 */
export type SmartAlbumFilters = Omit<SmartAlbumFiltersInput, "filterRaw"> & {
	filterRaw?: "raw" | "standard";
};

export type SmartAlbum = {
	id: number;
	name: string;
	filters: SmartAlbumFilters;
	query: string | null;
	/** Live count of matching photos; `null` for query albums. */
	photoCount: number | null;
	/** Highest-ID matching photo; `null` for query albums or no match. */
	cover: CollectionCover | null;
	createdAt: Date;
	updatedAt: Date;
};

export type SmartAlbumPatch = {
	name?: string;
	filters?: SmartAlbumFiltersInput;
	/** `null` clears the query; omitted keeps it. */
	query?: string | null;
};

export type SmartAlbumErrorCode = "NAME_TAKEN" | "NOT_FOUND" | "EMPTY";

/** Domain failure that both transports map to their own status codes. */
export class SmartAlbumError extends Error {
	constructor(
		readonly code: SmartAlbumErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SmartAlbumError";
	}
}

function invalidFilter(field: string): never {
	throw new RangeError(`Invalid smart album filter: ${field}`);
}

/**
 * Builds canonical filters from known keys only, in a fixed key order, so the
 * stored JSON is stable and keys written by older code are ignored on read.
 * Transports validate first; invalid known values still throw `RangeError`.
 */
export function canonicalizeSmartAlbumFilters(
	input: SmartAlbumFiltersInput,
): SmartAlbumFilters {
	const filters: SmartAlbumFilters = {};
	if (input.filterRaw === "raw" || input.filterRaw === "standard") {
		filters.filterRaw = input.filterRaw;
	} else if (input.filterRaw !== undefined && input.filterRaw !== "all") {
		invalidFilter("filterRaw");
	}
	for (const key of ["folder", "camera", "lens"] as const) {
		const value = input[key];
		if (value === undefined || value === "") continue;
		if (typeof value !== "string") invalidFilter(key);
		filters[key] = value;
	}
	if (input.iso !== undefined) {
		if (!Number.isInteger(input.iso) || input.iso < 1) invalidFilter("iso");
		filters.iso = input.iso;
	}
	if (input.dateMonth !== undefined && input.dateMonth !== "") {
		if (
			typeof input.dateMonth !== "string" ||
			!SMART_ALBUM_DATE_MONTH_PATTERN.test(input.dateMonth)
		) {
			invalidFilter("dateMonth");
		}
		filters.dateMonth = input.dateMonth.replace(":", "-");
	}
	if (input.minRating !== undefined) {
		if (
			!Number.isInteger(input.minRating) ||
			input.minRating < 1 ||
			input.minRating > 5
		) {
			invalidFilter("minRating");
		}
		filters.minRating = input.minRating;
	}
	if (input.flag !== undefined) {
		if (input.flag !== "unflagged" && !PHOTO_FLAGS.includes(input.flag)) {
			invalidFilter("flag");
		}
		filters.flag = input.flag;
	}
	if (input.tag !== undefined && input.tag !== "") {
		if (
			typeof input.tag !== "string" ||
			input.tag.length > MAX_TAG_SLUG_LENGTH ||
			!TAG_SLUG_PATTERN.test(input.tag)
		) {
			invalidFilter("tag");
		}
		filters.tag = input.tag;
	}
	if (input.country !== undefined && input.country !== "") {
		if (
			typeof input.country !== "string" ||
			!COUNTRY_CODE_PATTERN.test(input.country)
		) {
			invalidFilter("country");
		}
		filters.country = input.country;
	}
	if (input.place !== undefined) {
		if (!Number.isInteger(input.place) || input.place < 1) {
			invalidFilter("place");
		}
		filters.place = input.place;
	}
	return filters;
}

/** Trims and bounds an album name; transports validate first, this keeps the service safe. */
export function normalizeSmartAlbumName(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_SMART_ALBUM_NAME_LENGTH) {
		throw new RangeError(
			`Smart album name must be 1-${MAX_SMART_ALBUM_NAME_LENGTH} characters`,
		);
	}
	return trimmed;
}

function normalizeQuery(query: string | null): string | null {
	if (query === null) return null;
	const trimmed = query.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_SMART_ALBUM_QUERY_LENGTH) {
		throw new RangeError(
			`Smart album query must be 1-${MAX_SMART_ALBUM_QUERY_LENGTH} characters or null`,
		);
	}
	return trimmed;
}

function requireNonEmpty(filters: SmartAlbumFilters, query: string | null) {
	if (query === null && Object.keys(filters).length === 0) {
		throw new SmartAlbumError(
			"EMPTY",
			"A smart album needs at least one filter or a search query",
		);
	}
}

function notFound(): SmartAlbumError {
	return new SmartAlbumError("NOT_FOUND", "Smart album not found");
}

/** Runs a name write, translating the NOCASE unique index violation into NAME_TAKEN. */
function withUniqueName<T>(write: () => T): T {
	try {
		return write();
	} catch (error) {
		if (isUniqueConstraintViolation(error)) {
			throw new SmartAlbumError(
				"NAME_TAKEN",
				"A smart album with that name already exists",
			);
		}
		throw error;
	}
}

type LiveStatsRow = {
	photo_count: number;
	cover_photo_id: number | null;
	cover_thumbnail_updated_at: number | null;
};

/**
 * Evaluates a row into its DTO. Filter-only albums get one aggregate statement
 * (COUNT plus MAX(id) under the shared catalog filter conditions, which stack
 * RAW+JPEG pairs like the listing, joined back for the cover's cache token);
 * query albums have no stable count or cover.
 */
function toSmartAlbum(
	database: Executor,
	row: SmartAlbumRow,
	representation: PhotoCatalogRepresentation,
): SmartAlbum {
	// Stored canonically as `YYYY-MM`; re-canonicalizing drops unknown legacy keys.
	const filters = canonicalizeSmartAlbumFilters(
		JSON.parse(row.filters) as SmartAlbumFiltersInput,
	);
	let photoCount: number | null = null;
	let cover: CollectionCover | null = null;
	if (row.query === null) {
		const conditions = photoFilterConditions(filters, {
			normalizeDateMonths: true,
		});
		const [stats] = database.all<LiveStatsRow>(sql`
			SELECT
				stats.photo_count AS photo_count,
				cover.id AS cover_photo_id,
				cover.thumbnail_updated_at AS cover_thumbnail_updated_at
			FROM (
				SELECT count(*) AS photo_count, max(photos.id) AS cover_id
				FROM photos
				WHERE ${sql.join(conditions, sql` AND `)}
			) stats
			LEFT JOIN photos cover ON cover.id = stats.cover_id
		`);
		photoCount = stats?.photo_count ?? 0;
		if (stats && stats.cover_photo_id !== null) {
			cover = {
				photoId: stats.cover_photo_id,
				// Drizzle timestamp columns store whole seconds.
				thumbnailUpdatedAt:
					stats.cover_thumbnail_updated_at === null
						? null
						: new Date(stats.cover_thumbnail_updated_at * 1000),
			};
		}
	}
	return {
		id: row.id,
		name: row.name,
		filters:
			filters.dateMonth !== undefined && !representation.normalizeDateMonths
				? { ...filters, dateMonth: filters.dateMonth.replace("-", ":") }
				: filters,
		query: row.query,
		photoCount,
		cover,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * All smart albums sorted case-insensitively by name: one SELECT plus one
 * aggregate statement per filter-only album.
 */
export function listSmartAlbums(
	database: ApiDatabase,
	representation: PhotoCatalogRepresentation = {},
): SmartAlbum[] {
	return database
		.select()
		.from(smartAlbums)
		.orderBy(sql`${smartAlbums.name} COLLATE NOCASE ASC`, smartAlbums.id)
		.all()
		.map((row) => toSmartAlbum(database, row, representation));
}

export function createSmartAlbum(
	database: ApiDatabase,
	input: {
		name: string;
		filters: SmartAlbumFiltersInput;
		query?: string | null;
	},
	representation: PhotoCatalogRepresentation = {},
): SmartAlbum {
	const name = normalizeSmartAlbumName(input.name);
	const filters = canonicalizeSmartAlbumFilters(input.filters);
	const query = normalizeQuery(input.query ?? null);
	requireNonEmpty(filters, query);
	return withUniqueName(() => {
		const now = new Date();
		const row = database
			.insert(smartAlbums)
			.values({
				name,
				filters: JSON.stringify(filters),
				query,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
			.get();
		return toSmartAlbum(database, row, representation);
	});
}

/**
 * Applies a partial update. Provided `filters` replace the saved set; the
 * merged album must still have a filter or a query. Changing only the case of
 * its own name is allowed.
 */
export function updateSmartAlbum(
	database: ApiDatabase,
	id: number,
	patch: SmartAlbumPatch,
	representation: PhotoCatalogRepresentation = {},
): SmartAlbum {
	const name =
		patch.name === undefined ? undefined : normalizeSmartAlbumName(patch.name);
	const filters =
		patch.filters === undefined
			? undefined
			: canonicalizeSmartAlbumFilters(patch.filters);
	const query =
		patch.query === undefined ? undefined : normalizeQuery(patch.query);
	return withUniqueName(() =>
		database.transaction((tx) => {
			const current = tx
				.select()
				.from(smartAlbums)
				.where(eq(smartAlbums.id, id))
				.get();
			if (!current) throw notFound();
			const nextFilters =
				filters ??
				canonicalizeSmartAlbumFilters(
					JSON.parse(current.filters) as SmartAlbumFiltersInput,
				);
			const nextQuery = query === undefined ? current.query : query;
			requireNonEmpty(nextFilters, nextQuery);
			const row = tx
				.update(smartAlbums)
				.set({
					name: name ?? current.name,
					filters: JSON.stringify(nextFilters),
					query: nextQuery,
					updatedAt: new Date(),
				})
				.where(eq(smartAlbums.id, id))
				.returning()
				.get();
			return toSmartAlbum(tx, row, representation);
		}),
	);
}

/** Deletes a smart album; photos are never touched. */
export function deleteSmartAlbum(database: ApiDatabase, id: number): void {
	const deleted = database
		.delete(smartAlbums)
		.where(eq(smartAlbums.id, id))
		.returning({ id: smartAlbums.id })
		.get();
	if (!deleted) throw notFound();
}
