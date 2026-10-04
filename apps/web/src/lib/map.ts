import type { PhotoBounds, PhotoLocation, PhotoMetadata } from "@/lib/types";

/** Zoom used when centering on one photo ("Show on map", a single point). */
export const PHOTO_FOCUS_ZOOM = 14;

// Plain decimal or exponent notation, like the API's numeric-text check.
const NUMERIC_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function parseCoordinate(text: string | null | undefined): number | null {
	if (!text || !NUMERIC_TEXT.test(text)) return null;
	const value = Number(text);
	return Number.isFinite(value) ? value : null;
}

/**
 * The photo's location when it passes the API's validity rule: both values
 * numeric text, latitude in [-90, 90], longitude in [-180, 180], and not
 * both exactly 0 (the common bogus default). Null otherwise.
 */
export function photoLocation(
	photo: Pick<PhotoMetadata, "exif">,
): { latitude: number; longitude: number } | null {
	const latitude = parseCoordinate(photo.exif?.gpsLatitude);
	const longitude = parseCoordinate(photo.exif?.gpsLongitude);
	if (latitude === null || longitude === null) return null;
	if (latitude < -90 || latitude > 90) return null;
	if (longitude < -180 || longitude > 180) return null;
	if (latitude === 0 && longitude === 0) return null;
	return { latitude, longitude };
}

/** Wraps a longitude into [-180, 180], keeping exactly ±180 as given. */
function wrapLongitude(longitude: number) {
	if (longitude >= -180 && longitude <= 180) return longitude;
	return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

/**
 * Converts a MapLibre viewport (whose west/east exceed ±180 when the view
 * crosses the antimeridian or shows more than one world copy) into the API's
 * `bounds` filter: longitudes wrapped into [-180, 180], `west > east` when
 * the box crosses the antimeridian, and the whole longitude range once the
 * view spans 360° or more. Latitudes are clamped to [-90, 90].
 */
export function normalizeViewportBounds(viewport: {
	north: number;
	south: number;
	east: number;
	west: number;
}): PhotoBounds {
	const north = Math.min(90, Math.max(-90, viewport.north));
	const south = Math.min(90, Math.max(-90, viewport.south));
	if (viewport.east - viewport.west >= 360) {
		return { north, south, west: -180, east: 180 };
	}
	return {
		north,
		south,
		west: wrapLongitude(viewport.west),
		east: wrapLongitude(viewport.east),
	};
}

/** The API's `bounds` predicate, including the antimeridian wrap. */
export function locationInBounds(
	{ latitude, longitude }: Pick<PhotoLocation, "latitude" | "longitude">,
	bounds: PhotoBounds,
) {
	if (latitude < bounds.south || latitude > bounds.north) return false;
	return bounds.west <= bounds.east
		? longitude >= bounds.west && longitude <= bounds.east
		: longitude >= bounds.west || longitude <= bounds.east;
}
