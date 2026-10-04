import { sql } from "drizzle-orm";
import { capturedDateSql } from "../db/schema";
import {
	type ApiDatabase,
	cameraLabelSql,
	type PhotoCatalogRepresentation,
	type PhotoFilters,
	photoFilterConditions,
} from "./photo-catalog";

/** A camera or lens and its photo count. */
export type GearCount = { label: string; count: number };

/**
 * One histogram range. `min`/`max` are `null` for an open end. Focal length,
 * aperture, and ISO ranges are inclusive at both ends; shutter-speed ranges
 * exclude `min` (the previous bucket's `max`) and include `max`.
 */
export type GearBucketDefinition = {
	label: string;
	min: number | null;
	max: number | null;
};

export type GearBucket = GearBucketDefinition & { count: number };

export type GearCameraYear = { camera: string; year: number; count: number };

/** `gearStats` / `GET /api/v1/gear-stats` response. */
export type GearStats = {
	/** Photos in the set: exactly the listing's rows for the same filters. */
	total: number;
	/** Photos in the set with any camera, lens, or exposure EXIF value. */
	withExif: number;
	/** Every camera label, count descending then label ascending. */
	cameras: GearCount[];
	/** Every lens model, count descending then label ascending. */
	lenses: GearCount[];
	focalLengths: GearBucket[];
	apertures: GearBucket[];
	shutterSpeeds: GearBucket[];
	isos: GearBucket[];
	/** Year ascending, then count descending, then camera ascending. */
	cameraYears: GearCameraYear[];
};

/** Focal length in whole millimetres, inclusive ranges. */
export const FOCAL_LENGTH_BUCKETS: readonly GearBucketDefinition[] = [
	{ label: "≤15 mm", min: null, max: 15 },
	{ label: "16–23 mm", min: 16, max: 23 },
	{ label: "24–34 mm", min: 24, max: 34 },
	{ label: "35–49 mm", min: 35, max: 49 },
	{ label: "50–84 mm", min: 50, max: 84 },
	{ label: "85–134 mm", min: 85, max: 134 },
	{ label: "135–299 mm", min: 135, max: 299 },
	{ label: "≥300 mm", min: 300, max: null },
];

/** F-number parsed from `f/N.N`, rounded to one decimal, inclusive ranges. */
export const APERTURE_BUCKETS: readonly GearBucketDefinition[] = [
	{ label: "≤f/1.9", min: null, max: 1.9 },
	{ label: "f/2–2.7", min: 2.0, max: 2.7 },
	{ label: "f/2.8–3.9", min: 2.8, max: 3.9 },
	{ label: "f/4–5.5", min: 4.0, max: 5.5 },
	{ label: "f/5.6–7.9", min: 5.6, max: 7.9 },
	{ label: "f/8–10.9", min: 8.0, max: 10.9 },
	{ label: "≥f/11", min: 11.0, max: null },
];

/**
 * Exposure time in seconds (`1/N` is 1/N, `N.Ns` is N.N). `min` is exclusive
 * (the previous bucket's `max`), `max` inclusive.
 */
export const SHUTTER_SPEED_BUCKETS: readonly GearBucketDefinition[] = [
	{ label: "≤1/2000 s", min: null, max: 0.0005 },
	{ label: "1/1000–1/500 s", min: 0.0005, max: 0.002 },
	{ label: "1/250–1/125 s", min: 0.002, max: 0.008 },
	{ label: "1/60–1/30 s", min: 0.008, max: 0.0334 },
	{ label: "1/15–1/2 s", min: 0.0334, max: 0.5 },
	{ label: ">1/2 s", min: 0.5, max: null },
];

/** ISO speed, inclusive integer ranges. */
export const ISO_BUCKETS: readonly GearBucketDefinition[] = [
	{ label: "≤200", min: null, max: 200 },
	{ label: "400", min: 201, max: 400 },
	{ label: "800", min: 401, max: 800 },
	{ label: "1600", min: 801, max: 1600 },
	{ label: "3200", min: 1601, max: 3200 },
	{ label: "6400", min: 3201, max: 6400 },
	{ label: ">6400", min: 6401, max: null },
];

const APERTURE_PATTERN = /^f\/(\d+(?:\.\d+)?)$/;
const SHUTTER_FRACTION_PATTERN = /^1\/(\d+(?:\.\d+)?)$/;
const SHUTTER_SECONDS_PATTERN = /^(\d+(?:\.\d+)?)s$/;

/** The f-number of a stored `f/N.N` aperture rounded to one decimal, or null. */
export function parseAperture(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const match = APERTURE_PATTERN.exec(value);
	if (!match) return null;
	const fNumber = Math.round(Number(match[1]) * 10) / 10;
	return fNumber > 0 ? fNumber : null;
}

/** Seconds of a stored `1/N` or `N.Ns` shutter speed, or null. */
export function parseShutterSpeed(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const fraction = SHUTTER_FRACTION_PATTERN.exec(value);
	if (fraction) {
		const denominator = Number(fraction[1]);
		return denominator > 0 ? 1 / denominator : null;
	}
	const seconds = SHUTTER_SECONDS_PATTERN.exec(value);
	if (!seconds) return null;
	const duration = Number(seconds[1]);
	return duration > 0 ? duration : null;
}

/** A positive whole number (focal length, ISO), or null. */
function positiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: null;
}

type Dimension = "focal" | "aperture" | "shutter" | "iso";

const DIMENSIONS: Record<
	Dimension,
	{
		buckets: readonly GearBucketDefinition[];
		parse: (value: unknown) => number | null;
		/** Whether `min` itself is outside the bucket. */
		exclusiveMin: boolean;
	}
> = {
	focal: {
		buckets: FOCAL_LENGTH_BUCKETS,
		parse: positiveInteger,
		exclusiveMin: false,
	},
	aperture: {
		buckets: APERTURE_BUCKETS,
		parse: parseAperture,
		exclusiveMin: false,
	},
	shutter: {
		buckets: SHUTTER_SPEED_BUCKETS,
		parse: parseShutterSpeed,
		exclusiveMin: true,
	},
	iso: { buckets: ISO_BUCKETS, parse: positiveInteger, exclusiveMin: false },
};

type GearRow = {
	kind: "total" | "withExif" | "camera" | "lens" | Dimension | "cameraYear";
	value: string | number | null;
	year: number | null;
	count: number;
};

/**
 * Gear usage over exactly the photo set the library grid shows for `filters`:
 * `photoFilterConditions` including RAW+JPEG stacking, so `total` equals
 * `listPhotos(filters).total` and a pair counts once (through the row the
 * listing shows). One statement: the set joined to its EXIF row is
 * materialized once, then grouped per dimension by stored value; JS assigns
 * the few distinct values to the exported buckets.
 *
 * Camera labels use `cameraLabelSql` (the `camera` filter value). Empty camera
 * and lens labels are omitted. A missing or unparseable value (non-positive or
 * fractional focal length/ISO, aperture not `f/N.N`, shutter not `1/N` or
 * `N.Ns`) is left out of that dimension only. `cameraYears` counts photos with
 * a camera label and an EXIF capture date of `YYYY-MM-DD` digits (either
 * separator) in year 1900 or later; wall clock, no timezone conversion.
 */
export function gearStats(
	database: ApiDatabase,
	filters: PhotoFilters = {},
	representation: PhotoCatalogRepresentation = {},
): GearStats {
	const conditions = photoFilterConditions(filters, representation);
	const dateTaken = sql`gear_exif.date_taken`;
	const yearText = sql`substr(${dateTaken}, 1, 4)`;
	const rows = database.all<GearRow>(sql`
		WITH gear AS MATERIALIZED (
			SELECT
				${cameraLabelSql("gear_exif")} AS camera,
				gear_exif.lens_model AS lens,
				gear_exif.focal_length AS focal,
				gear_exif.aperture AS aperture,
				gear_exif.shutter_speed AS shutter,
				gear_exif.iso AS iso,
				CASE WHEN ${capturedDateSql(dateTaken)} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
					AND ${yearText} >= '1900'
					THEN CAST(${yearText} AS INTEGER) END AS year,
				coalesce(gear_exif.camera_make, gear_exif.camera_model, gear_exif.lens_model,
					gear_exif.focal_length, gear_exif.aperture, gear_exif.shutter_speed,
					gear_exif.iso) IS NOT NULL AS has_exif
			FROM photos
			LEFT JOIN photo_exif gear_exif ON gear_exif.photo_id = photos.id
			WHERE ${sql.join(conditions, sql` AND `)}
		)
		SELECT 'total' AS kind, NULL AS value, NULL AS year, count(*) AS count FROM gear
		UNION ALL SELECT 'withExif', NULL, NULL, count(*) FROM gear WHERE has_exif
		UNION ALL SELECT 'camera', camera, NULL, count(*) FROM gear
			WHERE camera <> '' GROUP BY camera
		UNION ALL SELECT 'lens', lens, NULL, count(*) FROM gear
			WHERE lens <> '' GROUP BY lens
		UNION ALL SELECT 'focal', focal, NULL, count(*) FROM gear
			WHERE focal IS NOT NULL GROUP BY focal
		UNION ALL SELECT 'aperture', aperture, NULL, count(*) FROM gear
			WHERE aperture IS NOT NULL GROUP BY aperture
		UNION ALL SELECT 'shutter', shutter, NULL, count(*) FROM gear
			WHERE shutter IS NOT NULL GROUP BY shutter
		UNION ALL SELECT 'iso', iso, NULL, count(*) FROM gear
			WHERE iso IS NOT NULL GROUP BY iso
		UNION ALL SELECT 'cameraYear', camera, year, count(*) FROM gear
			WHERE camera <> '' AND year IS NOT NULL GROUP BY camera, year
		-- Within each kind: cameras/lenses by count desc then label (BINARY);
		-- camera years by year, then count desc, then camera.
		ORDER BY year, count DESC, value
	`);

	const histograms = Object.fromEntries(
		Object.entries(DIMENSIONS).map(([dimension, { buckets }]) => [
			dimension,
			buckets.map((bucket) => ({ ...bucket, count: 0 })),
		]),
	) as Record<Dimension, GearBucket[]>;
	const result: GearStats = {
		total: 0,
		withExif: 0,
		cameras: [],
		lenses: [],
		focalLengths: histograms.focal,
		apertures: histograms.aperture,
		shutterSpeeds: histograms.shutter,
		isos: histograms.iso,
		cameraYears: [],
	};
	for (const row of rows) {
		switch (row.kind) {
			case "total":
				result.total = row.count;
				break;
			case "withExif":
				result.withExif = row.count;
				break;
			case "camera":
				result.cameras.push({ label: String(row.value), count: row.count });
				break;
			case "lens":
				result.lenses.push({ label: String(row.value), count: row.count });
				break;
			case "cameraYear":
				result.cameraYears.push({
					camera: String(row.value),
					year: Number(row.year),
					count: row.count,
				});
				break;
			default: {
				const { parse, exclusiveMin } = DIMENSIONS[row.kind];
				const value = parse(row.value);
				if (value === null) break;
				const bucket = histograms[row.kind].find(
					({ min, max }) =>
						(min === null || (exclusiveMin ? value > min : value >= min)) &&
						(max === null || value <= max),
				);
				if (bucket) bucket.count += row.count;
			}
		}
	}
	return result;
}
