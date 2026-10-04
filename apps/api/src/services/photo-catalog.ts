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

/** Library type filter; `all` stacks RAW+JPEG pairs and hides Live Photo motion clips. */
export const PHOTO_TYPE_FILTERS = ["all", "raw", "standard", "video"] as const;
export type PhotoTypeFilter = (typeof PHOTO_TYPE_FILTERS)[number];

/**
 * A video at most this long is a Live Photo motion clip when it is the only
 * video of its pair stem and the stem's stills stack into one visible still
 * (see `livePhotoSql`).
 */
export const LIVE_PHOTO_MAX_DURATION_MS = 4000;

export type PhotoFilters = {
	/**
	 * `raw`: RAW stills; `standard`: non-RAW stills; `video`: videos except Live
	 * Photo motion clips; `all` (default): everything with stacking.
	 */
	filterRaw?: PhotoTypeFilter;
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
 * Two stills (`media_type = 'photo'`) are a pair iff their pair stem
 * (lower-cased relative path minus the final extension, so same folder) has
 * exactly two stills, exactly one of them RAW, and their `photo_exif.date_taken`
 * values are equal whenever both are present (guards reused camera counters).
 * Three or more stills pair nothing; videos never pair and are not counted, so
 * a RAW+JPEG+MOV triple still pairs its two stills.
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
				AND pair_member.media_type = 'photo'
		) pair_candidate
		WHERE pair_candidate.id IS NOT NULL
			AND ${own}.media_type = 'photo'
			AND NOT EXISTS (SELECT 1 FROM photo_exif own_exif
				JOIN photo_exif partner_exif ON partner_exif.photo_id = pair_candidate.id
				WHERE own_exif.photo_id = ${own}.id AND own_exif.date_taken <> partner_exif.date_taken))`;
}

/**
 * Live Photo pairing over the same stem index: a video is a *motion clip* iff
 * it lasts at most `LIVE_PHOTO_MAX_DURATION_MS`, it is the only video of its
 * pair stem, and the stem's stills are exactly one still or exactly a RAW pair
 * (two stills, one RAW, which stack into one visible still). The clip belongs
 * to the still visible after RAW stacking: the standard still when there is
 * one, else the single RAW. Two non-RAW stills (`IMG_1.HEIC` + `IMG_1.JPG`)
 * or two videos make the moment ambiguous, so nothing stacks.
 *
 * For the row visible as `photo`: with `role: "still"`, its motion clip's ID
 * when it is the moment's still; with `role: "clip"`, the still's ID when it
 * is the motion clip. NULL otherwise. One aggregate over the stem's index range.
 */
function livePhotoSql(photo: string, role: "still" | "clip"): SQL {
	const own = sql.identifier(photo);
	const isStill = sql`live_member.media_type = 'photo'`;
	const isVideo = sql`live_member.media_type = 'video'`;
	const [ownMatches, picked] =
		role === "still"
			? [sql`live.still_id = ${own}.id`, sql`live.video_id`]
			: [sql`live.video_id = ${own}.id`, sql`live.still_id`];
	return sql`(SELECT CASE
			WHEN live.videos = 1
				AND live.video_ms <= ${LIVE_PHOTO_MAX_DURATION_MS}
				AND (live.stills = 1 OR (live.stills = 2 AND live.raw_stills = 1))
				AND ${ownMatches}
			THEN ${picked}
		END FROM (
			SELECT
				total(${isVideo}) AS videos,
				total(${isStill}) AS stills,
				total(${isStill} AND ifnull(live_member.is_raw, 0) = 1) AS raw_stills,
				max(CASE WHEN ${isVideo} THEN live_member.id END) AS video_id,
				max(CASE WHEN ${isVideo} THEN live_member.duration_ms END) AS video_ms,
				coalesce(
					max(CASE WHEN ${isStill} AND ifnull(live_member.is_raw, 0) = 0 THEN live_member.id END),
					max(CASE WHEN ${isStill} THEN live_member.id END)
				) AS still_id
			FROM photos live_member
			WHERE ${pairStem(sql`live_member.path`)} = ${pairStem(sql`${own}.path`)}
		) live)`;
}

/**
 * The Live Photo motion clip's ID for the still visible as `photo`, or NULL.
 * The gate is uncorrelated: SQLite builds the set of stills that own a clip
 * once per statement, probing the stem index only for short videos (index
 * search on `media_type`), so a listing pays one hash lookup per row and the
 * per-row aggregate runs only for the moment's still.
 */
export function motionVideoIdSql(photo = "photos"): SQL {
	const own = sql.identifier(photo);
	return sql`CASE WHEN ${own}.media_type = 'photo' AND ${own}.id IN (
			SELECT live_owner.still_id FROM (
				SELECT ${livePhotoSql("live_clip", "clip")} AS still_id
				FROM photos live_clip
				WHERE live_clip.media_type = 'video'
					AND live_clip.duration_ms <= ${LIVE_PHOTO_MAX_DURATION_MS}
			) live_owner WHERE live_owner.still_id IS NOT NULL)
		THEN ${livePhotoSql(photo, "still")} END`;
}

/**
 * The row visible as `photos` is not a Live Photo motion clip. Only short
 * videos reach the stem lookup. Part of every stacking condition and of the
 * `video` type filter; folder counts use it directly.
 */
export function notMotionClipCondition(): SQL {
	return sql`NOT (photos.media_type = 'video'
		AND ifnull(photos.duration_ms <= ${LIVE_PHOTO_MAX_DURATION_MS}, 0)
		AND ${livePhotoSql("photos", "clip")} IS NOT NULL)`;
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

/**
 * Relational-query `extras` adding the RAW pair and Live Photo fields to every
 * public photo.
 */
export const pairedPhotoExtras = {
	pairedPhotoId: sql<number | null>`${pairedPhotoIdSql()}`.as(
		"paired_photo_id",
	),
	pairedFormat: sql<string | null>`${pairedFormatSql()}`.as("paired_format"),
	motionVideoId: sql<number | null>`${motionVideoIdSql()}`.as(
		"motion_video_id",
	),
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
 * Stacking over the row visible as `photos`: Live Photo motion clips are
 * always omitted (`notMotionClipCondition`), and a RAW row is omitted iff its
 * partner also satisfies every `scope` condition (with no scope, iff it has a
 * partner). Only RAW rows reach the partner lookup and only short videos the
 * clip lookup. The derived table resolves the partner ID against the outer
 * row; the joined `photos` then shadows it, so the unchanged scope conditions
 * test the single partner row by primary key. `photoFilterConditions` appends
 * it; `onThisDay` and event detection use it directly because their scopes
 * are correlated rather than one value.
 */
export function pairStackingCondition(scope: readonly SQL[]): SQL {
	const partner = pairedPhotoIdSql();
	const raw =
		scope.length === 0
			? sql`NOT (ifnull(photos.is_raw, 0) = 1 AND ${partner} IS NOT NULL)`
			: sql`NOT (ifnull(photos.is_raw, 0) = 1 AND EXISTS (SELECT 1 FROM (SELECT ${partner} AS id) pair_partner INNER JOIN photos ON photos.id = pair_partner.id WHERE ${sql.join([...scope], sql` AND `)}))`;
	return sql`(${raw} AND ${notMotionClipCondition()})`;
}

/**
 * Folder tree with direct-child counts. Live Photo motion clips are not
 * counted (they never appear in the grid); RAW+JPEG pairs count as two files.
 * Paths are tallied per folder first, so the tree walk runs once per folder
 * rather than once per photo.
 */
export async function listFolders(database: ApiDatabase) {
	const results = await database
		.select({ path: photosTable.path })
		.from(photosTable)
		.where(notMotionClipCondition());
	const directCounts = new Map<string, number>();
	for (const { path } of results) {
		const lastSlash = path.lastIndexOf("/");
		if (lastSlash <= 0) continue;
		const folderPath = path.substring(0, lastSlash);
		directCounts.set(folderPath, (directCounts.get(folderPath) ?? 0) + 1);
	}

	const folderMap = new Map<string, FolderNode>();
	for (const [folderPath, count] of directCounts) {
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
		}
		const folder = folderMap.get(folderPath);
		if (folder) folder.photoCount = count;
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
 * The last condition stacks: Live Photo motion clips are dropped, and a RAW row
 * is dropped when its partner also satisfies every other condition, so the set
 * never shows both files of a pair. Under `filterRaw` raw/standard the type
 * filter already excludes partners and clips; under `video` only the clip rule
 * applies.
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
		conditions.push(
			sql`(${photosTable.mediaType} = 'photo' AND ${photosTable.isRaw} = 1)`,
		);
	} else if (input.filterRaw === "standard") {
		conditions.push(
			sql`(${photosTable.mediaType} = 'photo' AND ${photosTable.isRaw} = 0)`,
		);
	} else if (input.filterRaw === "video") {
		conditions.push(eq(photosTable.mediaType, "video"));
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
	if (input.filterRaw === "video") {
		conditions.push(notMotionClipCondition());
	} else if (input.filterRaw !== "raw" && input.filterRaw !== "standard") {
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
