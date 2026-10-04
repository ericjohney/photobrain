import { eq, gte, isNull, type SQL, sql } from "drizzle-orm";
import type { db as productionDb } from "../db";
import {
	capturedDateSql,
	pairStem,
	photoExif,
	photos as photosTable,
	publicPhotoColumns,
} from "../db/schema";
import { PLACE_DATASET_VERSION } from "./place-lookup";

export type ApiDatabase = typeof productionDb;

export type FolderNode = {
	name: string;
	path: string;
	photoCount: number;
	children: FolderNode[];
};

export type PhotoFilters = {
	filterRaw?: "all" | "raw" | "standard";
	folder?: string;
	camera?: string;
	lens?: string;
	iso?: number;
	dateMonth?: string;
	/** Minimum star rating, 1-5 (`rating >= minRating`). */
	minRating?: number;
	flag?: "pick" | "reject" | "unflagged";
	/** Only members of this collection. */
	collectionId?: number;
	/** Only photos carrying this automatic tag slug. */
	tag?: string;
	/** Only photos whose current place is in this ISO 3166-1 alpha-2 country. */
	country?: string;
	/** Only photos whose current place is this GeoNames city (geonameid). */
	place?: number;
	/**
	 * Only photos captured on this `YYYY-MM-DD` wall-clock date (validated by
	 * `isValidCapturedDate`). A view scope like `bounds`: never saved in smart albums.
	 */
	capturedDate?: string;
	/**
	 * Only members of this detected event (`events` id). A view scope like
	 * `capturedDate`: never saved in smart albums. An unknown id matches nothing.
	 */
	event?: number;
	/** Only photos with a valid location inside this box (edges inclusive). */
	bounds?: PhotoBounds;
};

/**
 * A latitude/longitude box in decimal degrees. `west > east` crosses the
 * antimeridian. Transports validate with `isValidPhotoBounds` first.
 */
export type PhotoBounds = {
	north: number;
	south: number;
	east: number;
	west: number;
};

export type PhotoLocation = { id: number; latitude: number; longitude: number };

/** `photoLocations` / `GET /api/v1/locations` response. */
export type PhotoLocationsResult = { points: PhotoLocation[]; total: number };

/** Finite, latitudes in [-90, 90], longitudes in [-180, 180], south <= north. */
export function isValidPhotoBounds(bounds: PhotoBounds): boolean {
	const { north, south, east, west } = bounds;
	return (
		[north, south, east, west].every(Number.isFinite) &&
		south >= -90 &&
		north <= 90 &&
		south <= north &&
		west >= -180 &&
		west <= 180 &&
		east >= -180 &&
		east <= 180
	);
}

/** Shape of a capture date (`capturedDate` filter, `onThisDay` `date`). */
export const CAPTURED_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real `YYYY-MM-DD` calendar date in year 1900 or later: the only values a
 * photo's capture date can take, so the transports reject anything else.
 */
export function isValidCapturedDate(value: string): boolean {
	if (!CAPTURED_DATE_PATTERN.test(value)) return false;
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	if (year < 1900 || month < 1 || month > 12 || day < 1) return false;
	// Day 0 of the next month is the last day of this one.
	return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * `LIKE ... ESCAPE '\'` pattern matching every path below `folder` (any
 * depth), with `_`, `%`, and `\` in folder names matching literally.
 */
export function folderSubtreePattern(folder: string): string {
	return `${folder.replace(/[\\%_]/g, "\\$&")}/%`;
}

/**
 * The row visible as `photos` was captured on `date`: its EXIF `date_taken`
 * normalizes (`capturedDateSql`) to it. Resolved through the
 * `idx_exif_captured_date` expression index, never a `photo_exif` scan.
 * `date` is a validated `YYYY-MM-DD` value or a correlated SQL expression.
 */
export function capturedDateCondition(date: string | SQL): SQL {
	return sql`${photosTable.id} IN (SELECT photo_id FROM photo_exif WHERE ${capturedDateSql(sql`photo_exif.date_taken`)} = ${date})`;
}

/**
 * The single camera label rule over the `photo_exif` row visible as `exif`:
 * the model when it already starts with the make (`LIKE`, so ASCII
 * case-insensitive), otherwise `make model`; NULL unless both are present.
 * The `camera` filter, `filterOptions` cameras, and gear stats all use it.
 */
export function cameraLabelSql(exif = "photo_exif"): SQL {
	const table = sql.identifier(exif);
	return sql`(CASE WHEN ${table}.camera_model LIKE ${table}.camera_make || '%'
		THEN ${table}.camera_model
		ELSE ${table}.camera_make || ' ' || ${table}.camera_model
	END)`;
}

/**
 * The single location validity rule, over the `photo_exif` row visible as
 * `exif`. `gps_latitude`/`gps_longitude` are TEXT holding decimal degrees; a
 * location is valid iff both are numeric text (the NUMERIC cast round-trips,
 * so empty, NULL, `abc`, `12abc`, and `Infinity` text fail), latitude is in
 * [-90, 90], longitude in [-180, 180] (which also excludes an overflowing
 * `1e999`), and not both exactly 0 (the common bogus default). Every location
 * read in the API goes through this builder.
 */
export function validLocationSql(exif = "photo_exif"): SQL {
	const { latitude, longitude, latitudeText, longitudeText } =
		locationColumns(exif);
	return sql`(${latitudeText} = CAST(${latitudeText} AS NUMERIC)
		AND ${longitudeText} = CAST(${longitudeText} AS NUMERIC)
		AND ${latitude} BETWEEN -90 AND 90
		AND ${longitude} BETWEEN -180 AND 180
		AND NOT (${latitude} = 0 AND ${longitude} = 0))`;
}

function locationColumns(exif: string) {
	const table = sql.identifier(exif);
	const latitudeText = sql`${table}.gps_latitude`;
	const longitudeText = sql`${table}.gps_longitude`;
	return {
		latitudeText,
		longitudeText,
		latitude: sql`CAST(${latitudeText} AS REAL)`,
		longitude: sql`CAST(${longitudeText} AS REAL)`,
	};
}

/**
 * The place row visible as `place` is current: computed with the current
 * dataset version from exactly the `photo_exif` coordinate texts the photo has
 * now (one probe of the unique `photo_exif.photo_id` index). A changed or
 * removed location therefore hides its stale place before the backfill runs.
 * Every place read in the API goes through this builder.
 */
export function currentPlaceSql(place = "photo_places"): SQL {
	const row = sql.identifier(place);
	return sql`(${row}.places_version = ${PLACE_DATASET_VERSION}
		AND EXISTS (SELECT 1 FROM photo_exif current_exif WHERE current_exif.photo_id = ${row}.photo_id
			AND current_exif.gps_latitude IS ${row}.latitude_text
			AND current_exif.gps_longitude IS ${row}.longitude_text))`;
}

/**
 * The row visible as `photos` has a valid location inside `bounds`: latitude
 * in [south, north] and longitude in [west, east], or, when `west > east`
 * (antimeridian wrap), longitude >= west OR <= east. Resolved through the
 * unique `photo_exif.photo_id` index.
 */
function locationCondition(bounds: PhotoBounds): SQL {
	const { latitude, longitude } = locationColumns("photo_exif");
	const longitudeRange =
		bounds.west <= bounds.east
			? sql`${longitude} BETWEEN ${bounds.west} AND ${bounds.east}`
			: sql`(${longitude} >= ${bounds.west} OR ${longitude} <= ${bounds.east})`;
	return sql`EXISTS (SELECT 1 FROM photo_exif WHERE photo_exif.photo_id = photos.id AND ${validLocationSql()}
		AND ${latitude} BETWEEN ${bounds.south} AND ${bounds.north} AND ${longitudeRange})`;
}

export type PhotoCatalogRepresentation = {
	normalizeDateMonths?: boolean;
};

/**
 * RAW+JPEG pairing, evaluated at query time over `idx_photos_pair_stem`.
 *
 * Two photos are a pair iff their pair stem (lower-cased relative path minus
 * the final extension, so same folder) has exactly two rows, exactly one of
 * them RAW, and their `photo_exif.date_taken` values are equal whenever both
 * are present (guards reused camera counters). Three or more rows pair nothing.
 *
 * The partner's ID for the row visible as `photo` in the enclosing query, or
 * NULL: one aggregate over the stem's index range (the row itself included)
 * names the candidate, and only then are the two dates compared by primary
 * key, so an unpaired row costs a single index probe. Every pair lookup in the
 * API goes through this builder.
 */
export function pairedPhotoIdSql(photo = "photos"): SQL {
	const own = sql.identifier(photo);
	return sql`(SELECT pair_candidate.id FROM (
			SELECT CASE
				WHEN count(*) = 2 AND total(ifnull(pair_member.is_raw, 0)) = 1
				THEN max(CASE WHEN pair_member.id <> ${own}.id THEN pair_member.id END)
			END AS id
			FROM photos pair_member
			WHERE ${pairStem(sql`pair_member.path`)} = ${pairStem(sql`${own}.path`)}
		) pair_candidate
		WHERE pair_candidate.id IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM photo_exif own_exif
				JOIN photo_exif partner_exif ON partner_exif.photo_id = pair_candidate.id
				WHERE own_exif.photo_id = ${own}.id AND own_exif.date_taken <> partner_exif.date_taken))`;
}

/**
 * The pair partner's format for the row visible as `photo`, or NULL: its
 * `raw_format` when the partner is RAW (its extension if that is unknown),
 * otherwise its upper-cased extension without the dot (`JPG`, `HEIC`).
 */
export function pairedFormatSql(photo = "photos"): SQL {
	const extension = sql`upper(substr(partner.path, length(rtrim(partner.path, replace(partner.path, '.', ''))) + 1))`;
	return sql`(SELECT CASE WHEN ifnull(partner.is_raw, 0) = 1 THEN coalesce(partner.raw_format, ${extension}) ELSE ${extension} END
		FROM photos partner WHERE partner.id = ${pairedPhotoIdSql(photo)})`;
}

/** Relational-query `extras` adding the pair fields to every public photo. */
export const pairedPhotoExtras = {
	pairedPhotoId: sql<number | null>`${pairedPhotoIdSql()}`.as(
		"paired_photo_id",
	),
	pairedFormat: sql<string | null>`${pairedFormatSql()}`.as("paired_format"),
};

/**
 * Subquery for `id IN (...)`: the given photo IDs plus their pair partners.
 * Curation and duplicate rejection apply to both files of a pair.
 */
export function photoIdsWithPartnersSql(ids: readonly number[]): SQL {
	const json = JSON.stringify(ids);
	return sql`SELECT value FROM json_each(${json})
		UNION
		SELECT partner_id FROM (
			SELECT ${pairedPhotoIdSql("source")} AS partner_id
			FROM photos source
			WHERE source.id IN (SELECT value FROM json_each(${json}))
		) WHERE partner_id IS NOT NULL`;
}

/**
 * Pair stacking over the row visible as `photos`: a RAW row is omitted iff its
 * partner also satisfies every `scope` condition (with no scope, iff it has a
 * partner). Only RAW rows reach the partner lookup. The derived table resolves
 * the partner ID against the outer row; the joined `photos` then shadows it, so
 * the unchanged scope conditions test the single partner row by primary key.
 * `photoFilterConditions` appends it; `onThisDay` uses it directly because its
 * scope (the row's own capture date) is correlated rather than one value.
 */
export function pairStackingCondition(scope: readonly SQL[]): SQL {
	const partner = pairedPhotoIdSql();
	return scope.length === 0
		? sql`NOT (ifnull(photos.is_raw, 0) = 1 AND ${partner} IS NOT NULL)`
		: sql`NOT (ifnull(photos.is_raw, 0) = 1 AND EXISTS (SELECT 1 FROM (SELECT ${partner} AS id) pair_partner INNER JOIN photos ON photos.id = pair_partner.id WHERE ${sql.join([...scope], sql` AND `)}))`;
}

export async function listFolders(database: ApiDatabase) {
	const results = await database
		.select({ path: photosTable.path })
		.from(photosTable);
	const folderMap = new Map<string, FolderNode>();

	for (const { path } of results) {
		const lastSlash = path.lastIndexOf("/");
		const folderPath = lastSlash > 0 ? path.substring(0, lastSlash) : "";
		if (!folderPath) continue;

		const parts = folderPath.split("/");
		let currentPath = "";
		for (let index = 0; index < parts.length; index++) {
			currentPath =
				index === 0 ? parts[index] : `${currentPath}/${parts[index]}`;
			if (!folderMap.has(currentPath)) {
				folderMap.set(currentPath, {
					name: parts[index],
					path: currentPath,
					photoCount: 0,
					children: [],
				});
			}
			if (index === parts.length - 1) {
				const folder = folderMap.get(currentPath);
				if (folder) folder.photoCount++;
			}
		}
	}

	const rootFolders: FolderNode[] = [];
	for (const [folderPath, folder] of folderMap) {
		const lastSlash = folderPath.lastIndexOf("/");
		if (lastSlash === -1) {
			rootFolders.push(folder);
			continue;
		}
		folderMap.get(folderPath.substring(0, lastSlash))?.children.push(folder);
	}

	const sortFolders = (folders: FolderNode[]): FolderNode[] =>
		folders
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((folder) => ({
				...folder,
				children: sortFolders(folder.children),
			}));

	return { folders: sortFolders(rootFolders), totalPhotos: results.length };
}

export async function listFilterOptions(
	database: ApiDatabase,
	input: { folder?: string } = {},
	representation: PhotoCatalogRepresentation = {},
) {
	const folderCondition = input.folder
		? sql` AND ${photosTable.path} LIKE ${`${input.folder}/%`}`
		: sql``;
	const dateMonthExpression = representation.normalizeDateMonths
		? sql`replace(substr(${photoExif.dateTaken}, 1, 7), ':', '-')`
		: sql`substr(${photoExif.dateTaken}, 1, 7)`;
	const camerasResult = await database.all<{ camera: string }>(sql`
		SELECT DISTINCT ${cameraLabelSql()} as camera
		FROM ${photoExif}
		INNER JOIN ${photosTable} ON ${photosTable.id} = ${photoExif.photoId}
		WHERE ${photoExif.cameraMake} IS NOT NULL AND ${photoExif.cameraModel} IS NOT NULL${folderCondition}
		ORDER BY camera
	`);
	const lensesResult = await database.all<{ lens: string }>(sql`
		SELECT DISTINCT ${photoExif.lensModel} as lens
		FROM ${photoExif}
		INNER JOIN ${photosTable} ON ${photosTable.id} = ${photoExif.photoId}
		WHERE ${photoExif.lensModel} IS NOT NULL${folderCondition}
		ORDER BY lens
	`);
	const isosResult = await database.all<{ iso: number }>(sql`
		SELECT DISTINCT ${photoExif.iso} as iso
		FROM ${photoExif}
		INNER JOIN ${photosTable} ON ${photosTable.id} = ${photoExif.photoId}
		WHERE ${photoExif.iso} IS NOT NULL${folderCondition}
		ORDER BY iso
	`);
	const datesResult = await database.all<{ month: string }>(sql`
		SELECT DISTINCT ${dateMonthExpression} as month
		FROM ${photoExif}
		INNER JOIN ${photosTable} ON ${photosTable.id} = ${photoExif.photoId}
		WHERE ${photoExif.dateTaken} IS NOT NULL${folderCondition}
		ORDER BY month
	`);
	const tagsResult = await database.all<{ tag: string; count: number }>(sql`
		SELECT t.tag as tag, count(*) as count
		FROM photo_tags t
		INNER JOIN ${photosTable} ON ${photosTable.id} = t.photo_id
		WHERE 1 = 1${folderCondition}
		GROUP BY t.tag
		ORDER BY count DESC, tag ASC
	`);
	// Places count current rows only, folder-scoped like tags.
	const countriesResult = await database.all<{
		code: string;
		name: string;
		count: number;
	}>(sql`
		SELECT photo_places.country_code AS code, photo_places.country AS name, count(*) AS count
		FROM photo_places
		INNER JOIN ${photosTable} ON ${photosTable.id} = photo_places.photo_id
		WHERE ${currentPlaceSql()}${folderCondition}
		GROUP BY photo_places.country_code, photo_places.country
		ORDER BY count DESC, name ASC, code ASC
	`);
	const placesResult = await database.all<{
		id: number;
		name: string;
		region: string | null;
		countryCode: string;
		count: number;
	}>(sql`
		SELECT photo_places.geoname_id AS id, photo_places.city AS name, photo_places.region AS region,
			photo_places.country_code AS countryCode, count(*) AS count
		FROM photo_places
		INNER JOIN ${photosTable} ON ${photosTable.id} = photo_places.photo_id
		WHERE ${currentPlaceSql()}${folderCondition}
		GROUP BY photo_places.geoname_id
		ORDER BY count DESC, name ASC, id ASC
	`);

	return {
		cameras: camerasResult.map(({ camera }) => camera),
		lenses: lensesResult.map(({ lens }) => lens),
		isos: isosResult.map(({ iso }) => iso),
		dates: datesResult.map(({ month }) => month),
		tags: tagsResult,
		countries: countriesResult,
		places: placesResult,
	};
}

/**
 * SQL conditions over `photos` (and correlated `photo_exif` lookups) shared by the
 * library listing, vector search, similarity, and smart-album counts so filter
 * meaning cannot drift between them. `folder` matches direct children only.
 * The last condition stacks RAW+JPEG pairs: a RAW row is dropped when its
 * partner also satisfies every other condition, so the set never shows both
 * files of a pair (omitted under `filterRaw` raw/standard, which already does).
 */
export function photoFilterConditions(
	input: PhotoFilters,
	representation: PhotoCatalogRepresentation = {},
): SQL[] {
	const conditions: SQL[] = [];
	const dateMonthExpression = representation.normalizeDateMonths
		? sql`replace(substr(photo_exif.date_taken, 1, 7), ':', '-')`
		: sql`substr(photo_exif.date_taken, 1, 7)`;
	if (input.filterRaw === "raw") {
		conditions.push(eq(photosTable.isRaw, true));
	} else if (input.filterRaw === "standard") {
		conditions.push(eq(photosTable.isRaw, false));
	}
	if (input.folder) {
		const folderPrefix = folderSubtreePattern(input.folder);
		conditions.push(
			sql`(${photosTable.path} LIKE ${folderPrefix} ESCAPE '\\' AND instr(substr(${photosTable.path}, length(${input.folder}) + 2), '/') = 0)`,
		);
	}
	if (input.camera) {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM photo_exif WHERE photo_exif.photo_id = photos.id AND ${cameraLabelSql()} = ${input.camera})`,
		);
	}
	if (input.lens) {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM photo_exif WHERE photo_exif.photo_id = photos.id AND photo_exif.lens_model = ${input.lens})`,
		);
	}
	if (input.iso) {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM photo_exif WHERE photo_exif.photo_id = photos.id AND photo_exif.iso = ${input.iso})`,
		);
	}
	if (input.dateMonth) {
		conditions.push(
			sql`EXISTS (SELECT 1 FROM photo_exif WHERE photo_exif.photo_id = photos.id AND ${dateMonthExpression} = ${input.dateMonth})`,
		);
	}
	if (input.minRating !== undefined) {
		conditions.push(gte(photosTable.rating, input.minRating));
	}
	if (input.flag === "unflagged") {
		conditions.push(isNull(photosTable.flag));
	} else if (input.flag) {
		conditions.push(eq(photosTable.flag, input.flag));
	}
	if (input.collectionId !== undefined) {
		// Resolved through the (collection_id, photo_id) primary key.
		conditions.push(
			sql`${photosTable.id} IN (SELECT photo_id FROM collection_photos WHERE collection_id = ${input.collectionId})`,
		);
	}
	if (input.tag !== undefined) {
		// Resolved through the (tag, photo_id) index.
		conditions.push(
			sql`${photosTable.id} IN (SELECT photo_id FROM photo_tags WHERE tag = ${input.tag})`,
		);
	}
	if (input.country !== undefined) {
		// Resolved through the (country_code, photo_id) index.
		conditions.push(
			sql`${photosTable.id} IN (SELECT photo_id FROM photo_places WHERE country_code = ${input.country} AND ${currentPlaceSql()})`,
		);
	}
	if (input.place !== undefined) {
		// Resolved through the (geoname_id, photo_id) index.
		conditions.push(
			sql`${photosTable.id} IN (SELECT photo_id FROM photo_places WHERE geoname_id = ${input.place} AND ${currentPlaceSql()})`,
		);
	}
	if (input.capturedDate !== undefined) {
		conditions.push(capturedDateCondition(input.capturedDate));
	}
	if (input.event !== undefined) {
		// Resolved through the (event_id, photo_id) primary key.
		conditions.push(
			sql`${photosTable.id} IN (SELECT photo_id FROM event_photos WHERE event_id = ${input.event})`,
		);
	}
	if (input.bounds) {
		conditions.push(locationCondition(input.bounds));
	}
	// A type filter already excludes the partner of every row it admits.
	if (input.filterRaw !== "raw" && input.filterRaw !== "standard") {
		conditions.push(pairStackingCondition(conditions));
	}
	return conditions;
}

export async function listPhotos(
	database: ApiDatabase,
	input: PhotoFilters = {},
	representation: PhotoCatalogRepresentation = {},
) {
	const conditions = photoFilterConditions(input, representation);
	const photos = await database.query.photos.findMany({
		columns: publicPhotoColumns,
		extras: pairedPhotoExtras,
		where: sql.join(conditions, sql` AND `),
		with: { exif: true },
	});

	return {
		photos,
		total: photos.length,
		// A standard row's partner is always the RAW file of its pair.
		rawCount: photos.filter(
			(photo) => photo.isRaw || photo.pairedPhotoId !== null,
		).length,
	};
}

const WHOLE_WORLD: PhotoBounds = {
	north: 90,
	south: -90,
	east: 180,
	west: -180,
};

/**
 * Every photo matching `input` with a valid location, ordered by ID, in one
 * statement without relational hydration. The location requirement always
 * runs before RAW+JPEG stacking (as the whole-world box when no `bounds` is
 * given), so a pair yields its standard file's point, or the RAW's when only
 * the RAW is geotagged: the same rows as `listPhotos` with that box.
 */
export function listPhotoLocations(
	database: ApiDatabase,
	input: PhotoFilters = {},
	representation: PhotoCatalogRepresentation = {},
): PhotoLocationsResult {
	const conditions = photoFilterConditions(
		{ ...input, bounds: input.bounds ?? WHOLE_WORLD },
		representation,
	);
	const points = database.all<PhotoLocation>(sql`
		SELECT photos.id AS id,
			CAST(location.gps_latitude AS REAL) AS latitude,
			CAST(location.gps_longitude AS REAL) AS longitude
		FROM photos
		INNER JOIN photo_exif location ON location.photo_id = photos.id
		WHERE ${sql.join(conditions, sql` AND `)}
		ORDER BY photos.id
	`);
	return { points, total: points.length };
}

export async function getPhoto(database: ApiDatabase, id: number) {
	return database.query.photos.findFirst({
		columns: publicPhotoColumns,
		extras: pairedPhotoExtras,
		where: (photos, operators) => operators.eq(photos.id, id),
		with: { exif: true },
	});
}
