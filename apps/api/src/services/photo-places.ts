import { sql } from "drizzle-orm";
import {
	type ApiDatabase,
	currentPlaceSql,
	validLocationSql,
} from "./photo-catalog";
import { PLACE_DATASET_VERSION, type PlaceIndex } from "./place-lookup";

/** Photos read, geocoded, and written per backfill step. */
export const PLACE_BACKFILL_BATCH_SIZE = 1_000;

/** `photoPlace` / `GET /api/v1/photos/:id/place` place. */
export type PhotoPlace = {
	/** GeoNames geonameid (the `place` filter value). */
	id: number;
	city: string;
	region: string | null;
	country: string;
	countryCode: string;
};

type PlaceBackfillRow = {
	photoId: number;
	latitudeText: string | null;
	longitudeText: string | null;
	latitude: number | null;
	longitude: number | null;
	valid: 0 | 1;
};

export type PlaceBatchResult = {
	/** Photos read past the cursor; fewer than the limit ends the backfill. */
	read: number;
	/** Place rows inserted or replaced. */
	placed: number;
	/** Place rows deleted (location removed/invalid or no city within 100 km). */
	removed: number;
	/** Last photo ID read (the next step's exclusive cursor). */
	cursor: number;
};

/**
 * One idempotent backfill step in a single transaction. Reads up to `limit`
 * photos past `afterPhotoId` (keyset by photo ID) that need work: a valid
 * location without a current place, or a place row whose photo no longer has a
 * valid location. Geocodes each valid location with `index` (nearest city
 * within 100 km), upserting the place with the exact coordinate texts and
 * current dataset version, and deletes rows for invalid locations or no match.
 * Valid locations with no city nearby are re-read (and re-checked) by every
 * run because nothing is stored for them; a lookup costs well under 50 µs.
 */
export function placePhotoBatch(
	database: ApiDatabase,
	index: PlaceIndex,
	afterPhotoId: number,
	limit = PLACE_BACKFILL_BATCH_SIZE,
): PlaceBatchResult {
	return database.transaction((tx) => {
		const rows = tx.all<PlaceBackfillRow>(sql`
			SELECT photoId, latitudeText, longitudeText, latitude, longitude, valid
			FROM (
				SELECT photos.id AS photoId,
					location.gps_latitude AS latitudeText,
					location.gps_longitude AS longitudeText,
					CAST(location.gps_latitude AS REAL) AS latitude,
					CAST(location.gps_longitude AS REAL) AS longitude,
					CASE WHEN location.photo_id IS NOT NULL AND ${validLocationSql("location")} THEN 1 ELSE 0 END AS valid,
					photo_places.photo_id IS NOT NULL AS hasPlace,
					CASE WHEN photo_places.photo_id IS NOT NULL AND ${currentPlaceSql()} THEN 1 ELSE 0 END AS isCurrent
				FROM photos
				LEFT JOIN photo_exif location ON location.photo_id = photos.id
				LEFT JOIN photo_places ON photo_places.photo_id = photos.id
				WHERE photos.id > ${afterPhotoId}
			)
			WHERE (valid = 1 AND isCurrent = 0) OR (valid = 0 AND hasPlace = 1)
			ORDER BY photoId
			LIMIT ${limit}
		`);
		let placed = 0;
		const removedIds: number[] = [];
		for (const row of rows) {
			const place =
				row.valid === 1 && row.latitude !== null && row.longitude !== null
					? index.lookup(row.latitude, row.longitude)
					: null;
			if (!place) {
				removedIds.push(row.photoId);
				continue;
			}
			tx.run(sql`
				INSERT INTO photo_places (photo_id, geoname_id, city, region, country_code, country,
					latitude_text, longitude_text, places_version)
				VALUES (${row.photoId}, ${place.id}, ${place.city}, ${place.region}, ${place.countryCode},
					${place.country}, ${row.latitudeText}, ${row.longitudeText}, ${PLACE_DATASET_VERSION})
				ON CONFLICT (photo_id) DO UPDATE SET
					geoname_id = excluded.geoname_id, city = excluded.city, region = excluded.region,
					country_code = excluded.country_code, country = excluded.country,
					latitude_text = excluded.latitude_text, longitude_text = excluded.longitude_text,
					places_version = excluded.places_version
			`);
			placed++;
		}
		let removed = 0;
		if (removedIds.length > 0) {
			removed = tx.all<{ photo_id: number }>(sql`
					DELETE FROM photo_places
					WHERE photo_id IN (SELECT value FROM json_each(${JSON.stringify(removedIds)}))
					RETURNING photo_id
				`).length;
		}
		return {
			read: rows.length,
			placed,
			removed,
			cursor: rows.at(-1)?.photoId ?? afterPhotoId,
		};
	});
}

/**
 * A photo's current place in one statement.
 * @returns `null` when the photo does not exist; `{ place: null }` when it has
 * no current place (no or invalid GPS, no city within 100 km, or not yet backfilled).
 */
export function getPhotoPlace(
	database: ApiDatabase,
	photoId: number,
): { place: PhotoPlace | null } | null {
	// `all` maps columns by name; drizzle's raw `get` returns a positional row.
	const [row] = database.all<{
		id: number | null;
		city: string | null;
		region: string | null;
		country: string | null;
		countryCode: string | null;
	}>(sql`
		SELECT photo_places.geoname_id AS id, photo_places.city AS city, photo_places.region AS region,
			photo_places.country AS country, photo_places.country_code AS countryCode
		FROM photos
		LEFT JOIN photo_places ON photo_places.photo_id = photos.id AND ${currentPlaceSql()}
		WHERE photos.id = ${photoId}
	`);
	if (!row) return null;
	const { id, city, region, country, countryCode } = row;
	return {
		place:
			id === null || city === null || country === null || countryCode === null
				? null
				: { id, city, region, country, countryCode },
	};
}
