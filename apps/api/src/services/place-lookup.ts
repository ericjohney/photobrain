import { readFileSync } from "node:fs";

/**
 * Version of the place dataset and matching rule. Bump it whenever
 * `src/data/places.tsv.gz` is regenerated or the rule below changes; stored
 * places from another version stop being current and the `place-photos-v1`
 * backfill recomputes them.
 */
export const PLACE_DATASET_VERSION = 1;

/** A photo only gets a place when the nearest city is at most this far away. */
export const PLACE_MAX_DISTANCE_KM = 100;

/** `country` filter values: ISO 3166-1 alpha-2, uppercase. */
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

const EARTH_RADIUS_KM = 6371.0088;
const RADIANS = Math.PI / 180;
/** Degrees of latitude spanned by the match radius. */
const RADIUS_LATITUDE_DEGREES =
	PLACE_MAX_DISTANCE_KM / (EARTH_RADIUS_KM * RADIANS);
/** Haversine `a` at the match radius; `a` grows monotonically with distance. */
const MAX_HAVERSINE =
	Math.sin(PLACE_MAX_DISTANCE_KM / EARTH_RADIUS_KM / 2) ** 2;
const ROWS = 180;
const COLUMNS = 360;

export type Place = {
	/** GeoNames geonameid. */
	id: number;
	city: string;
	region: string | null;
	countryCode: string;
	country: string;
};

export type PlaceDatasetEntry = Place & { latitude: number; longitude: number };

export type PlaceIndex = {
	size: number;
	/** Nearest place within 100 km (inclusive), or `null`. */
	lookup(latitude: number, longitude: number): Place | null;
};

/** Great-circle distance in kilometres. */
export function haversineKm(
	latitude1: number,
	longitude1: number,
	latitude2: number,
	longitude2: number,
): number {
	const a =
		Math.sin(((latitude2 - latitude1) * RADIANS) / 2) ** 2 +
		Math.cos(latitude1 * RADIANS) *
			Math.cos(latitude2 * RADIANS) *
			Math.sin(((longitude2 - longitude1) * RADIANS) / 2) ** 2;
	return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

const rowOf = (latitude: number) =>
	Math.min(ROWS - 1, Math.max(0, Math.floor(latitude + 90)));

/**
 * Builds the in-memory 1° grid index. Each lookup scans only the cells
 * covering the 100 km radius: rows clamped at the poles, columns widened by
 * 1/cos(latitude) at the radius' most poleward edge and wrapped across the
 * antimeridian (every column when the radius reaches a pole).
 */
export function createPlaceIndex(
	entries: readonly PlaceDatasetEntry[],
): PlaceIndex {
	const count = entries.length;
	const latitudes = new Float64Array(count);
	const longitudes = new Float64Array(count);
	const cosines = new Float64Array(count);
	const cellOf = new Uint32Array(count);
	const cellStart = new Uint32Array(ROWS * COLUMNS + 1);
	for (let index = 0; index < count; index++) {
		const { latitude, longitude } = entries[index];
		latitudes[index] = latitude * RADIANS;
		longitudes[index] = longitude * RADIANS;
		cosines[index] = Math.cos(latitude * RADIANS);
		// Longitude 180 wraps into the -180 column.
		cellOf[index] =
			rowOf(latitude) * COLUMNS + (Math.floor(longitude + 180) % COLUMNS);
		cellStart[cellOf[index] + 1]++;
	}
	for (let cell = 0; cell < ROWS * COLUMNS; cell++) {
		cellStart[cell + 1] += cellStart[cell];
	}
	const cellItems = new Uint32Array(count);
	const fill = cellStart.slice(0, ROWS * COLUMNS);
	for (let index = 0; index < count; index++) {
		cellItems[fill[cellOf[index]]++] = index;
	}

	return {
		size: count,
		lookup(latitude, longitude) {
			const latitudeRadians = latitude * RADIANS;
			const longitudeRadians = longitude * RADIANS;
			const cosine = Math.cos(latitudeRadians);
			const south = latitude - RADIUS_LATITUDE_DEGREES;
			const north = latitude + RADIUS_LATITUDE_DEGREES;
			const poleward = Math.max(Math.abs(south), Math.abs(north));
			const longitudeSpan =
				poleward >= 90
					? COLUMNS
					: RADIUS_LATITUDE_DEGREES / Math.cos(poleward * RADIANS);
			const allColumns = longitudeSpan * 2 + 2 >= COLUMNS;
			const firstColumn = allColumns
				? 0
				: Math.floor(longitude - longitudeSpan + 180);
			const columnCount = allColumns
				? COLUMNS
				: Math.floor(longitude + longitudeSpan + 180) - firstColumn + 1;
			let best = -1;
			let bestHaversine = MAX_HAVERSINE;
			for (let row = rowOf(south); row <= rowOf(north); row++) {
				for (let offset = 0; offset < columnCount; offset++) {
					const cell =
						row * COLUMNS +
						((((firstColumn + offset) % COLUMNS) + COLUMNS) % COLUMNS);
					for (let slot = cellStart[cell]; slot < cellStart[cell + 1]; slot++) {
						const index = cellItems[slot];
						const a =
							Math.sin((latitudes[index] - latitudeRadians) / 2) ** 2 +
							cosine *
								cosines[index] *
								Math.sin((longitudes[index] - longitudeRadians) / 2) ** 2;
						if (a < bestHaversine || (a === bestHaversine && best === -1)) {
							best = index;
							bestHaversine = a;
						}
					}
				}
			}
			if (best === -1) return null;
			const { id, city, region, countryCode, country } = entries[best];
			return { id, city, region, countryCode, country };
		},
	};
}

/** Parses the generator's TSV (see `scripts/build-places.ts`). */
export function parsePlaceDataset(text: string): PlaceDatasetEntry[] {
	const countries: Record<string, string> = {};
	const entries: PlaceDatasetEntry[] = [];
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const columns = line.split("\t");
		if (line.startsWith("@")) {
			countries[columns[0].slice(1)] = columns[1];
			continue;
		}
		const country = countries[columns[3]];
		if (columns.length !== 6 || country === undefined) {
			throw new Error(`Malformed place dataset line: ${line}`);
		}
		entries.push({
			id: Number(columns[0]),
			city: columns[1],
			region: columns[2] === "" ? null : columns[2],
			countryCode: columns[3],
			country,
			latitude: Number(columns[4]),
			longitude: Number(columns[5]),
		});
	}
	return entries;
}

let defaultIndex: PlaceIndex | undefined;

/** The committed dataset's index, gunzipped and parsed once per process on first use. */
export function loadPlaceIndex(): PlaceIndex {
	defaultIndex ??= createPlaceIndex(
		parsePlaceDataset(
			new TextDecoder().decode(
				Bun.gunzipSync(
					readFileSync(new URL("../data/places.tsv.gz", import.meta.url)),
				),
			),
		),
	);
	return defaultIndex;
}

/** Nearest committed-dataset city within 100 km of the coordinates, or `null`. */
export function lookupPlace(latitude: number, longitude: number): Place | null {
	return loadPlaceIndex().lookup(latitude, longitude);
}
