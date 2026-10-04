export type FixturePhoto = {
	id: number;
	path: string;
	name: string;
	size: number;
	width: number;
	height: number;
	mimeType: string;
	createdAt: Date;
	modifiedAt: Date;
	isRaw: boolean;
	rawFormat: string | null;
	rawStatus: string | null;
	rawError: string | null;
	/** The other file of a RAW+standard pair (same folder and stem), like the API. */
	pairedPhotoId: number | null;
	/** Partner's RAW format, or its upper-cased extension when it is standard. */
	pairedFormat: string | null;
	mediaType: "photo" | "video";
	/** Video duration; null for stills (and videos ffprobe could not time). */
	durationMs: number | null;
	/** ffprobe codec name of a video's first stream, e.g. `h264`, `hevc`. */
	videoCodec: string | null;
	/** A still's Live Photo motion clip (a hidden video), like the API. */
	motionVideoId: number | null;
	thumbnailStatus: string;
	embeddingStatus: string;
	phashStatus: string;
	rating: number;
	flag: "pick" | "reject" | null;
	/** Thumbnail cache token; unset (undefined) on most fixtures. */
	thumbnailUpdatedAt?: Date | null;
	exif: {
		id: number;
		photoId: number;
		cameraMake: string | null;
		cameraModel: string | null;
		lensMake: string | null;
		lensModel: string | null;
		focalLength: number | null;
		iso: number | null;
		aperture: string | null;
		shutterSpeed: string | null;
		exposureBias: string | null;
		dateTaken: string | null;
		gpsLatitude: string | null;
		gpsLongitude: string | null;
		gpsAltitude: string | null;
	} | null;
};

function makePhoto(
	id: number,
	overrides: Partial<FixturePhoto> = {},
): FixturePhoto {
	return {
		id,
		path: `photos/2024/photo-${id}.jpg`,
		name: `photo-${id}.jpg`,
		size: 2_000_000 + id * 100_000,
		width: 4000,
		height: 3000,
		mimeType: "image/jpeg",
		createdAt: new Date("2024-06-15T12:00:00.000Z"),
		modifiedAt: new Date("2024-06-15T12:00:00.000Z"),
		isRaw: false,
		rawFormat: null,
		rawStatus: null,
		rawError: null,
		pairedPhotoId: null,
		pairedFormat: null,
		mediaType: "photo",
		durationMs: null,
		videoCodec: null,
		motionVideoId: null,
		thumbnailStatus: "completed",
		embeddingStatus: "completed",
		phashStatus: "completed",
		rating: 0,
		flag: null,
		exif: {
			id,
			photoId: id,
			cameraMake: "Sony",
			cameraModel: "A7III",
			lensMake: "Sony",
			lensModel: "FE 24-70mm f/2.8 GM",
			focalLength: 35,
			iso: 100,
			aperture: "f/8",
			shutterSpeed: "1/250",
			exposureBias: "0",
			dateTaken: "2024-06-15T12:00:00.000Z",
			gpsLatitude: null,
			gpsLongitude: null,
			gpsAltitude: null,
		},
		...overrides,
	};
}

function gps(gpsLatitude: string, gpsLongitude: string) {
	return { gpsLatitude, gpsLongitude };
}

export const FIXTURE_PHOTOS: FixturePhoto[] = [
	makePhoto(1, {
		name: "sunset.jpg",
		path: "photos/2024/sunset.jpg",
		rating: 5,
		flag: "pick",
		exif: { ...makePhoto(1).exif!, ...gps("37.8199", "-122.4783") },
	}),
	makePhoto(2, {
		name: "portrait.arw",
		path: "photos/2024/portrait.arw",
		isRaw: true,
		rawFormat: "ARW",
		rawStatus: "converted",
		mimeType: "image/x-sony-arw",
	}),
	makePhoto(3, {
		name: "landscape.jpg",
		path: "photos/2024/landscape.jpg",
		exif: {
			...makePhoto(3).exif!,
			cameraMake: "Canon",
			cameraModel: "EOS R5",
			gpsLatitude: "37.7749",
			gpsLongitude: "-122.4194",
			gpsAltitude: "52",
		},
	}),
	makePhoto(4, {
		name: "macro.cr2",
		path: "photos/2024/macro.cr2",
		isRaw: true,
		rawFormat: "CR2",
		mimeType: "image/x-canon-cr2",
		rating: 1,
		flag: "reject",
	}),
	// "On this day" (June 15): one year ago in EXIF's colon format.
	makePhoto(5, {
		name: "street.jpg",
		path: "photos/2024/street.jpg",
		width: 4000,
		height: 6000,
		exif: { ...makePhoto(5).exif!, dateTaken: "2025:06:15 08:00:00" },
	}),
	makePhoto(6, {
		name: "beach.jpg",
		path: "photos/2024/beach.jpg",
		rating: 3,
		exif: { ...makePhoto(6).exif!, ...gps("21.281", "-157.8374") },
	}),
	// Fiji (7) and Samoa (9) sit on either side of the antimeridian.
	makePhoto(7, {
		name: "mountain.heic",
		path: "photos/2024/mountain.heic",
		mimeType: "image/heic",
		exif: {
			...makePhoto(7).exif!,
			...gps("-17.7134", "178.065"),
			dateTaken: "2019:06:15 10:00:00",
		},
	}),
	makePhoto(8, {
		name: "forest.jpg",
		path: "photos/2024/forest.jpg",
		rating: 4,
		flag: "pick",
		pairedPhotoId: 13,
		pairedFormat: "ARW",
		thumbnailUpdatedAt: new Date("2025-06-16T08:00:00.000Z"),
		exif: {
			...makePhoto(8).exif!,
			...gps("47.6062", "-122.3321"),
			dateTaken: "2025:06:15 18:30:00",
		},
	}),
	makePhoto(9, {
		name: "city.jpg",
		path: "photos/2024/city.jpg",
		exif: { ...makePhoto(9).exif!, ...gps("-13.8333", "-171.7667") },
	}),
	// Invalid locations the map ignores: non-numeric text and the 0,0 default.
	// Flower is the evening before "On this day" (June 14).
	makePhoto(10, {
		name: "flower.jpg",
		path: "photos/2024/flower.jpg",
		exif: {
			...makePhoto(10).exif!,
			...gps("unknown", "12.5"),
			dateTaken: "2024:06:14 23:59:59",
		},
	}),
	// No EXIF: the timeline falls back to its file dates, on a day of its own so
	// its place never depends on the browser's time zone.
	makePhoto(11, {
		name: "cat.jpg",
		path: "photos/2024/cat.jpg",
		createdAt: new Date("2023-03-10T12:00:00.000Z"),
		modifiedAt: new Date("2023-03-10T12:00:00.000Z"),
		exif: null,
	}),
	makePhoto(12, {
		name: "dog.jpg",
		path: "photos/2024/dog.jpg",
		exif: { ...makePhoto(12).exif!, ...gps("0", "0") },
	}),
	// RAW half of the forest pair: stacked under forest.jpg (8) unless a filter
	// keeps only the RAW. Curated together with its partner, like the API does.
	makePhoto(13, {
		name: "forest.arw",
		path: "photos/2024/forest.arw",
		isRaw: true,
		rawFormat: "ARW",
		rawStatus: "converted",
		mimeType: "image/x-sony-arw",
		rating: 4,
		flag: "pick",
		pairedPhotoId: 8,
		pairedFormat: "JPG",
		exif: {
			...makePhoto(13).exif!,
			...gps("47.6062", "-122.3321"),
			dateTaken: "2025:06:15 18:30:00",
		},
	}),
];

/** `makePhoto(id)`'s EXIF with another capture date. */
function exifTakenAt(id: number, dateTaken: string): FixturePhoto["exif"] {
	const exif = makePhoto(id).exif;
	return exif && { ...exif, dateTaken };
}

/** A video fixture in `photos/clips`, captured on day `day` of January 2026. */
function makeVideo(
	id: number,
	name: string,
	day: number,
	overrides: Partial<FixturePhoto> = {},
): FixturePhoto {
	return makePhoto(id, {
		name,
		path: `photos/clips/${name}`,
		width: 1920,
		height: 1080,
		mimeType: name.endsWith(".mov") ? "video/quicktime" : "video/mp4",
		mediaType: "video",
		videoCodec: "h264",
		exif: exifTakenAt(id, `2026:01:${String(day).padStart(2, "0")} 10:00:00`),
		...overrides,
	});
}

/**
 * A separate video library (not part of FIXTURE_PHOTOS, so existing specs keep
 * their counts): `formatDuration` boundaries 0, 59.9 s, 60 s, 1 h, 65 s and
 * null, plus a Live Photo — the still `live.heic` (36) whose 2.5 s motion clip
 * `live.mov` (37) is hidden from listings like the API does.
 */
export const FIXTURE_VIDEOS: FixturePhoto[] = [
	makeVideo(30, "zero.mp4", 1, { durationMs: 0 }),
	makeVideo(31, "almost-minute.mp4", 2, { durationMs: 59_900 }),
	makeVideo(32, "minute.mp4", 3, { durationMs: 60_000 }),
	makeVideo(33, "hour.mov", 4, {
		durationMs: 3_600_000,
		videoCodec: "hevc",
		thumbnailUpdatedAt: new Date("2026-01-05T00:00:00.000Z"),
	}),
	makeVideo(34, "clip.mp4", 5, { durationMs: 65_000 }),
	makeVideo(35, "unknown.mp4", 6, { durationMs: null, videoCodec: null }),
	makePhoto(36, {
		name: "live.heic",
		path: "photos/clips/live.heic",
		mimeType: "image/heic",
		motionVideoId: 37,
		exif: exifTakenAt(36, "2026:01:07 10:00:00"),
	}),
	makeVideo(37, "live.mov", 7, { durationMs: 2_500, videoCodec: "hevc" }),
];

/** Folder counts are per file (not stacked), like the API's folder tree. */
export const FIXTURE_FOLDERS = {
	folders: [
		{
			name: "2024",
			path: "photos/2024",
			photoCount: FIXTURE_PHOTOS.length,
			children: [],
		},
	],
	totalPhotos: FIXTURE_PHOTOS.length,
};

export type FixturePhotoTag = { tag: string; score: number };

/**
 * Auto tags per photo ID, highest score first like the API. 20 distinct tags
 * (more than the 12 the Tags filter shows before "Show all"); cat.jpg (11)
 * is untagged.
 */
export const FIXTURE_PHOTO_TAGS: Record<number, FixturePhotoTag[]> = {
	1: [
		{ tag: "sunset", score: 0.62 },
		{ tag: "sky", score: 0.21 },
		{ tag: "beach", score: 0.11 },
	],
	2: [
		{ tag: "portrait", score: 0.71 },
		{ tag: "person", score: 0.18 },
	],
	3: [
		{ tag: "landscape", score: 0.55 },
		{ tag: "mountain", score: 0.3 },
		{ tag: "sky", score: 0.1 },
	],
	4: [
		{ tag: "macro", score: 0.8 },
		{ tag: "flowers", score: 0.12 },
	],
	5: [
		{ tag: "street", score: 0.5 },
		{ tag: "city", score: 0.35 },
	],
	6: [
		{ tag: "beach", score: 0.66 },
		{ tag: "ocean", score: 0.24 },
		{ tag: "sky", score: 0.1 },
	],
	7: [
		{ tag: "night-sky", score: 0.48 },
		{ tag: "mountain", score: 0.4 },
		{ tag: "snow", score: 0.12 },
	],
	8: [
		{ tag: "forest", score: 0.7 },
		{ tag: "tree", score: 0.2 },
	],
	9: [
		{ tag: "city", score: 0.6 },
		{ tag: "architecture", score: 0.25 },
		{ tag: "night-sky", score: 0.1 },
	],
	10: [
		{ tag: "flowers", score: 0.75 },
		{ tag: "garden", score: 0.15 },
	],
	12: [
		{ tag: "dog", score: 0.8 },
		{ tag: "pet", score: 0.15 },
	],
};

/** Tag counts over `photos`, sorted like the API: count desc, then tag asc. */
export function fixtureTagCounts(photos: FixturePhoto[]) {
	const counts = new Map<string, number>();
	for (const photo of photos) {
		for (const { tag } of FIXTURE_PHOTO_TAGS[photo.id] ?? []) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	return [...counts]
		.map(([tag, count]) => ({ tag, count }))
		.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export type FixturePlace = {
	id: number;
	city: string;
	region: string | null;
	country: string;
	countryCode: string;
};

const SAN_FRANCISCO: FixturePlace = {
	id: 5391959,
	city: "San Francisco",
	region: "California",
	country: "United States",
	countryCode: "US",
};
const HONOLULU: FixturePlace = {
	id: 5856195,
	city: "Honolulu",
	region: "Hawaii",
	country: "United States",
	countryCode: "US",
};
const SEATTLE: FixturePlace = {
	id: 5809844,
	city: "Seattle",
	region: "Washington",
	country: "United States",
	countryCode: "US",
};
const NADI: FixturePlace = {
	id: 2202064,
	city: "Nadi",
	region: "Western",
	country: "Fiji",
	countryCode: "FJ",
};
const APIA: FixturePlace = {
	id: 4035413,
	city: "Apia",
	region: "Tuamasaga",
	country: "Samoa",
	countryCode: "WS",
};

/**
 * Current offline-geocoded place per photo ID (the API's `photo_places`).
 * Every validly geotagged photo has one; invalid/missing GPS (2, 4, 5, 10,
 * 11, 12) has none.
 */
export const FIXTURE_PHOTO_PLACES: Record<number, FixturePlace> = {
	1: SAN_FRANCISCO,
	3: SAN_FRANCISCO,
	6: HONOLULU,
	7: NADI,
	8: SEATTLE,
	9: APIA,
	13: SEATTLE,
};

/**
 * Country and city filter options over `photos`, like the API: photo rows
 * (no pair stacking), ordered count desc, then name asc.
 */
export function fixturePlaceOptions(photos: FixturePhoto[]) {
	const countries = new Map<
		string,
		{ code: string; name: string; count: number }
	>();
	const places = new Map<
		number,
		{
			id: number;
			name: string;
			region: string | null;
			countryCode: string;
			count: number;
		}
	>();
	for (const photo of photos) {
		const place = FIXTURE_PHOTO_PLACES[photo.id];
		if (!place) continue;
		const country = countries.get(place.countryCode) ?? {
			code: place.countryCode,
			name: place.country,
			count: 0,
		};
		country.count++;
		countries.set(place.countryCode, country);
		const city = places.get(place.id) ?? {
			id: place.id,
			name: place.city,
			region: place.region,
			countryCode: place.countryCode,
			count: 0,
		};
		city.count++;
		places.set(place.id, city);
	}
	const byCountThenName = (
		a: { name: string; count: number },
		b: { name: string; count: number },
	) => b.count - a.count || a.name.localeCompare(b.name);
	return {
		countries: [...countries.values()].sort(byCountThenName),
		places: [...places.values()].sort(byCountThenName),
	};
}

export type FixtureJunkReason = "screenshot" | "document" | "blurry" | "dark";

/**
 * Junk review reasons per photo ID, in the API's order. Review candidates are
 * 3, 7, 9, 10, 11 and 12; sunset (1, picked) and beach (6, rated) have reasons
 * but are excluded like the API excludes picked/rated photos.
 */
export const FIXTURE_JUNK_REASONS: Record<number, FixtureJunkReason[]> = {
	1: ["blurry"],
	3: ["blurry"],
	6: ["dark"],
	7: ["blurry", "dark"],
	9: ["dark"],
	10: ["blurry"],
	11: ["screenshot"],
	12: ["document", "blurry"],
};

export type FixtureDuplicateKind = "duplicate" | "burst";

/**
 * Candidate duplicate/burst groups before the API's exclusions. Rejected
 * members (macro.cr2, 4) drop out, so the shown groups, in API order, are
 * duplicate 2,5,9 (keeper portrait.arw: RAW), burst 6,7,8 (keeper forest:
 * ★4), duplicate 10,12 (keeper dog: larger file) and duplicate 1,3 (keeper
 * sunset: ★5).
 */
export const FIXTURE_DUPLICATE_GROUPS: {
	kind: FixtureDuplicateKind;
	photoIds: number[];
	maxDistance: number | null;
}[] = [
	{ kind: "duplicate", photoIds: [2, 5, 9], maxDistance: 4 },
	{ kind: "duplicate", photoIds: [10, 12], maxDistance: 2 },
	{ kind: "burst", photoIds: [6, 7, 8], maxDistance: null },
	{ kind: "duplicate", photoIds: [1, 3, 4], maxDistance: 1 },
];

export function searchPhotosByQuery(
	query: string,
	photos: FixturePhoto[] = FIXTURE_PHOTOS,
): FixturePhoto[] {
	const q = query.toLowerCase();
	return photos.filter(
		(p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
	);
}

export type FixturePhotoBounds = {
	north: number;
	south: number;
	east: number;
	west: number;
};

export type FixturePhotoFilters = {
	folder?: string;
	filterRaw?: "all" | "raw" | "standard" | "video";
	camera?: string;
	lens?: string;
	iso?: number;
	dateMonth?: string;
	minRating?: number;
	flag?: "pick" | "reject" | "unflagged";
	tag?: string;
	country?: string;
	place?: number;
	/** "On this day" capture date, `YYYY-MM-DD`. */
	capturedDate?: string;
	/** Auto event id (see FIXTURE_EVENTS); an unknown id matches nothing. */
	event?: number;
	bounds?: FixturePhotoBounds;
};

/**
 * The API's single location validity rule: numeric latitude/longitude text,
 * latitude in [-90, 90], longitude in [-180, 180], and not exactly 0,0.
 */
export function fixtureLocation(
	photo: FixturePhoto,
): { latitude: number; longitude: number } | null {
	const numeric = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
	const latText = photo.exif?.gpsLatitude;
	const lonText = photo.exif?.gpsLongitude;
	if (!latText || !lonText || !numeric.test(latText) || !numeric.test(lonText))
		return null;
	const latitude = Number(latText);
	const longitude = Number(lonText);
	if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
	if (latitude === 0 && longitude === 0) return null;
	return { latitude, longitude };
}

/** The API's `bounds` predicate, including the antimeridian wrap. */
function inBounds(photo: FixturePhoto, bounds: FixturePhotoBounds) {
	const location = fixtureLocation(photo);
	if (!location) return false;
	const { latitude, longitude } = location;
	if (latitude < bounds.south || latitude > bounds.north) return false;
	return bounds.west <= bounds.east
		? longitude >= bounds.west && longitude <= bounds.east
		: longitude >= bounds.west || longitude <= bounds.east;
}

/**
 * The API's capture date: the first 10 characters of EXIF `dateTaken` with
 * `:` as `-`, valid only as `YYYY-MM-DD` with year >= 1900 (wall clock, no
 * time zone conversion).
 */
export function fixtureCapturedDate(photo: FixturePhoto): string | null {
	const date = photo.exif?.dateTaken?.slice(0, 10).replaceAll(":", "-");
	if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	return Number(date.slice(0, 4)) >= 1900 ? date : null;
}

/**
 * The library grid's default order (sort by capture date): EXIF wall-clock
 * capture time, else `modifiedAt`, oldest first, ID tiebreak. Fixture
 * fallback dates sit on days without EXIF photos, so comparing them in UTC
 * orders them as the browser's local time does.
 */
export function fixtureCapturedOrder(photos: FixturePhoto[]): FixturePhoto[] {
	const key = (photo: FixturePhoto) => {
		const day = fixtureCapturedDate(photo);
		const dateTaken = photo.exif?.dateTaken;
		return day && dateTaken
			? `${day}T${dateTaken.slice(11, 19)}`
			: photo.modifiedAt.toISOString().slice(0, 19);
	};
	return [...photos].sort(
		(a, b) => key(a).localeCompare(key(b)) || a.id - b.id,
	);
}

/** Photo IDs in the library grid's default (capture date) order. */
export function fixtureGridIds(photos: FixturePhoto[]): number[] {
	return fixtureCapturedOrder(photos).map((p) => p.id);
}

/** Camera label as the API composes it: model alone when it already starts with the make. */
function cameraLabel(exif: NonNullable<FixturePhoto["exif"]>) {
	if (!exif.cameraMake || !exif.cameraModel) return null;
	return exif.cameraModel.startsWith(exif.cameraMake)
		? exif.cameraModel
		: `${exif.cameraMake} ${exif.cameraModel}`;
}

/**
 * Mirrors the API's shared library/search filter semantics (folder = direct
 * children only), including RAW+standard stacking: a RAW is omitted when its
 * pair partner also matches, so `all` shows a pair as its standard file while
 * `raw` (or a collection holding only the RAW) shows the RAW. Live Photo
 * motion clips (a still's `motionVideoId`) are never listed. `raw` and
 * `standard` are stills only; `video` is videos only.
 */
export function filterFixturePhotos(
	photos: FixturePhoto[],
	filters: FixturePhotoFilters = {},
): FixturePhoto[] {
	const motionClipIds = new Set(
		photos.flatMap((p) => (p.motionVideoId === null ? [] : [p.motionVideoId])),
	);
	const matching = photos.filter((p) => {
		if (motionClipIds.has(p.id)) return false;
		if (
			filters.folder !== undefined &&
			p.path.slice(0, p.path.lastIndexOf("/")) !== filters.folder
		) {
			return false;
		}
		const isVideo = p.mediaType === "video";
		if (filters.filterRaw === "raw" && !p.isRaw) return false;
		if (filters.filterRaw === "standard" && (p.isRaw || isVideo)) return false;
		if (filters.filterRaw === "video" && !isVideo) return false;
		const exif = p.exif;
		if (filters.camera !== undefined) {
			if (!exif || cameraLabel(exif) !== filters.camera) return false;
		}
		if (filters.lens !== undefined && exif?.lensModel !== filters.lens) {
			return false;
		}
		if (filters.iso !== undefined && exif?.iso !== filters.iso) return false;
		if (
			filters.dateMonth !== undefined &&
			exif?.dateTaken?.slice(0, 7) !== filters.dateMonth
		) {
			return false;
		}
		if (filters.minRating !== undefined && p.rating < filters.minRating) {
			return false;
		}
		if (filters.flag === "unflagged") {
			if (p.flag !== null) return false;
		} else if (filters.flag !== undefined && p.flag !== filters.flag) {
			return false;
		}
		if (
			filters.tag !== undefined &&
			!FIXTURE_PHOTO_TAGS[p.id]?.some(({ tag }) => tag === filters.tag)
		) {
			return false;
		}
		const place = FIXTURE_PHOTO_PLACES[p.id];
		if (
			filters.country !== undefined &&
			place?.countryCode !== filters.country
		) {
			return false;
		}
		if (filters.place !== undefined && place?.id !== filters.place) {
			return false;
		}
		if (
			filters.capturedDate !== undefined &&
			fixtureCapturedDate(p) !== filters.capturedDate
		) {
			return false;
		}
		if (filters.event !== undefined) {
			// A stacked pair is one member: its RAW belongs with its partner.
			const members =
				FIXTURE_EVENTS.find((e) => e.id === filters.event)?.memberIds ?? [];
			if (
				!members.includes(p.id) &&
				!(p.pairedPhotoId !== null && members.includes(p.pairedPhotoId))
			) {
				return false;
			}
		}
		if (filters.bounds !== undefined && !inBounds(p, filters.bounds)) {
			return false;
		}
		return true;
	});
	const matchingIds = new Set(matching.map((p) => p.id));
	return matching.filter(
		(p) =>
			!(
				p.isRaw &&
				p.pairedPhotoId !== null &&
				matchingIds.has(p.pairedPhotoId)
			),
	);
}

/** The unfiltered library grid: every fixture photo with pairs stacked. */
export const FIXTURE_LIBRARY = filterFixturePhotos(FIXTURE_PHOTOS);

/**
 * The API's `onThisDay({ date })`: per earlier year (newest first, at most
 * 20), the non-rejected stacked photos captured on `date`'s month-day. On
 * Feb 28 of a non-leap year, Feb 29 photos join their year's group, whose
 * `capturedDate` is Feb 29 only when that year has no Feb 28 photos. The
 * cover is the highest rating, then latest capture time, then highest id.
 */
export function fixtureOnThisDay(photos: FixturePhoto[], date: string) {
	const year = Number(date.slice(0, 4));
	const monthDay = date.slice(5);
	const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const monthDays =
		monthDay === "02-28" && !leapYear ? ["02-28", "02-29"] : [monthDay];
	const groups = new Map<number, FixturePhoto[]>();
	for (const photo of filterFixturePhotos(photos)) {
		const captured = fixtureCapturedDate(photo);
		if (photo.flag === "reject" || !captured) continue;
		const photoYear = Number(captured.slice(0, 4));
		if (photoYear >= year || !monthDays.includes(captured.slice(5))) continue;
		groups.set(photoYear, [...(groups.get(photoYear) ?? []), photo]);
	}
	const years = [...groups.entries()]
		.sort(([a], [b]) => b - a)
		.slice(0, 20)
		.map(([groupYear, members]) => {
			const capturedDates = members.map((p) => fixtureCapturedDate(p));
			const cover = [...members].sort(
				(a, b) =>
					b.rating - a.rating ||
					(b.exif?.dateTaken ?? "").localeCompare(a.exif?.dateTaken ?? "") ||
					b.id - a.id,
			)[0];
			return {
				year: groupYear,
				yearsAgo: year - groupYear,
				capturedDate: capturedDates.includes(`${groupYear}-${monthDays[0]}`)
					? `${groupYear}-${monthDays[0]}`
					: `${groupYear}-${monthDays[1]}`,
				count: members.length,
				cover: {
					photoId: cover.id,
					thumbnailUpdatedAt: cover.thumbnailUpdatedAt ?? null,
				},
			};
		});
	return { date, years };
}

export type FixtureEventPlace = {
	city: string | null;
	region: string | null;
	country: string;
	countryCode: string;
};

/**
 * Auto events (the API's `events`/`event_photos`): disjoint stacked members
 * of the fixture library, one per display variant. They are smaller than the
 * API's six-photo minimum because the fixture library is.
 */
export const FIXTURE_EVENTS: {
	id: number;
	startAt: string;
	endAt: string;
	memberIds: number[];
	coverId: number;
	place: FixtureEventPlace | null;
}[] = [
	// City place, same day.
	{
		id: 1,
		startAt: "2024-06-15T09:00:00",
		endAt: "2024-06-15T17:30:00",
		memberIds: [1, 3],
		coverId: 1,
		place: {
			city: "San Francisco",
			region: "California",
			country: "United States",
			countryCode: "US",
		},
	},
	// Country-only place, same month; the cover has a thumbnail cache token.
	{
		id: 6,
		startAt: "2024-06-14T10:00:00",
		endAt: "2024-06-16T20:00:00",
		memberIds: [6, 8],
		coverId: 8,
		place: {
			city: null,
			region: null,
			country: "United States",
			countryCode: "US",
		},
	},
	// A city named like its country, same year across months.
	{
		id: 7,
		startAt: "2019-09-30T08:00:00",
		endAt: "2019-10-02T19:00:00",
		memberIds: [7],
		coverId: 7,
		place: {
			city: "Singapore",
			region: null,
			country: "Singapore",
			countryCode: "SG",
		},
	},
	// No place, across years.
	{
		id: 9,
		startAt: "2023-12-30T22:00:00",
		endAt: "2024-01-02T01:00:00",
		memberIds: [9],
		coverId: 9,
		place: null,
	},
	// No place, same day.
	{
		id: 2,
		startAt: "2025-06-15T08:00:00",
		endAt: "2025-06-15T08:30:00",
		memberIds: [2, 5],
		coverId: 5,
		place: null,
	},
	// No place, across months of one year.
	{
		id: 10,
		startAt: "2024-05-30T12:00:00",
		endAt: "2024-06-14T23:59:59",
		memberIds: [10, 12],
		coverId: 10,
		place: null,
	},
];

/** One `events` row as the API returns it. */
export type FixtureEventDto = {
	id: number;
	startAt: string;
	endAt: string;
	photoCount: number;
	cover: { photoId: number; thumbnailUpdatedAt: Date | null };
	place: FixtureEventPlace | null;
};

/**
 * The API's `events({ folder })`: newest first (startAt desc, then id desc);
 * with a folder, events with any member file in its subtree, still counting
 * every member.
 */
export function fixtureEvents(
	photos: FixturePhoto[],
	folder?: string,
): { events: FixtureEventDto[] } {
	const inFolder = (photo: FixturePhoto) =>
		folder === undefined || photo.path.startsWith(`${folder}/`);
	const events = FIXTURE_EVENTS.filter(({ memberIds }) =>
		photos.some(
			(p) =>
				(memberIds.includes(p.id) ||
					(p.pairedPhotoId !== null && memberIds.includes(p.pairedPhotoId))) &&
				inFolder(p),
		),
	)
		.sort((a, b) => b.startAt.localeCompare(a.startAt) || b.id - a.id)
		.map(({ id, startAt, endAt, memberIds, coverId, place }) => ({
			id,
			startAt,
			endAt,
			photoCount: memberIds.length,
			cover: {
				photoId: coverId,
				thumbnailUpdatedAt:
					photos.find((p) => p.id === coverId)?.thumbnailUpdatedAt ?? null,
			},
			place,
		}));
	return { events };
}

/** One gear stats histogram bucket as the API returns it. */
export type FixtureGearBucket = {
	label: string;
	min: number | null;
	max: number | null;
	count: number;
};

/** One camera/lens row as the API returns it. */
export type FixtureGearCount = { label: string; count: number };

export type FixtureCameraYear = { camera: string; year: number; count: number };

/** The API's `gearStats` response. */
export type FixtureGearStats = {
	total: number;
	withExif: number;
	cameras: FixtureGearCount[];
	lenses: FixtureGearCount[];
	focalLengths: FixtureGearBucket[];
	apertures: FixtureGearBucket[];
	shutterSpeeds: FixtureGearBucket[];
	isos: FixtureGearBucket[];
	cameraYears: FixtureCameraYear[];
};

type BucketBounds = [label: string, min: number | null, max: number | null];

/** The API's fixed bucket definitions, in display order. */
export const FIXTURE_GEAR_BUCKETS: Record<
	"focalLengths" | "apertures" | "shutterSpeeds" | "isos",
	BucketBounds[]
> = {
	focalLengths: [
		["≤15 mm", null, 15],
		["16–23 mm", 16, 23],
		["24–34 mm", 24, 34],
		["35–49 mm", 35, 49],
		["50–84 mm", 50, 84],
		["85–134 mm", 85, 134],
		["135–299 mm", 135, 299],
		["≥300 mm", 300, null],
	],
	apertures: [
		["≤f/1.9", null, 1.9],
		["f/2–2.7", 2.0, 2.7],
		["f/2.8–3.9", 2.8, 3.9],
		["f/4–5.5", 4.0, 5.5],
		["f/5.6–7.9", 5.6, 7.9],
		["f/8–10.9", 8.0, 10.9],
		["≥f/11", 11.0, null],
	],
	shutterSpeeds: [
		["≤1/2000 s", null, 0.0005],
		["1/1000–1/500 s", 0.0005, 0.002],
		["1/250–1/125 s", 0.002, 0.008],
		["1/60–1/30 s", 0.008, 0.0334],
		["1/15–1/2 s", 0.0334, 0.5],
		[">1/2 s", 0.5, null],
	],
	isos: [
		["≤200", null, 200],
		["400", 201, 400],
		["800", 401, 800],
		["1600", 801, 1600],
		["3200", 1601, 3200],
		["6400", 3201, 6400],
		[">6400", 6401, null],
	],
};

/**
 * Every bucket in order with its count. Buckets are contiguous, so a value
 * belongs to the first bucket whose (inclusive) max it does not exceed; for
 * shutter speeds that makes the lower bound exclusive, as in the API.
 */
function fixtureBuckets(
	bounds: BucketBounds[],
	values: (number | null)[],
): FixtureGearBucket[] {
	const buckets = bounds.map(([label, min, max]) => ({
		label,
		min,
		max,
		count: 0,
	}));
	for (const value of values) {
		if (value === null || !Number.isFinite(value)) continue;
		const bucket = buckets.find((b) => b.max === null || value <= b.max);
		if (bucket) bucket.count++;
	}
	return buckets;
}

/** Count desc, then label asc, like the API's camera and lens lists. */
function fixtureCounts(labels: (string | null)[]) {
	const counts = new Map<string, number>();
	for (const label of labels) {
		if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts]
		.map(([label, count]) => ({ label, count }))
		.sort(
			(a, b) =>
				b.count - a.count ||
				(a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
		);
}

/** `f/N.N` → N.N rounded to one decimal, else null. */
function fixtureAperture(text: string | null) {
	const match = text?.match(/^f\/(\d+(?:\.\d+)?)$/);
	return match ? Math.round(Number(match[1]) * 10) / 10 : null;
}

/** `1/N` → 1/N seconds, `N.Ns` → N.N seconds, else null. */
function fixtureShutterSeconds(text: string | null) {
	const fraction = text?.match(/^1\/(\d+(?:\.\d+)?)$/);
	if (fraction) return 1 / Number(fraction[1]);
	const seconds = text?.match(/^(\d+(?:\.\d+)?)s$/);
	return seconds ? Number(seconds[1]) : null;
}

/**
 * The API's `gearStats` over an already filtered and stacked photo set (the
 * library grid's photos for the same filters).
 */
export function fixtureGearStats(photos: FixturePhoto[]): FixtureGearStats {
	const exifs = photos.flatMap((p) => (p.exif ? [p.exif] : []));
	const cameraYears = new Map<string, FixtureCameraYear>();
	for (const exif of exifs) {
		const camera = cameraLabel(exif);
		const year = Number(exif.dateTaken?.slice(0, 4));
		if (!camera || !(year >= 1900)) continue;
		const key = `${camera}\n${year}`;
		const entry = cameraYears.get(key) ?? { camera, year, count: 0 };
		entry.count++;
		cameraYears.set(key, entry);
	}
	return {
		total: photos.length,
		withExif: exifs.filter(
			(e) =>
				e.cameraMake !== null ||
				e.cameraModel !== null ||
				e.lensModel !== null ||
				e.focalLength !== null ||
				e.aperture !== null ||
				e.shutterSpeed !== null ||
				e.iso !== null,
		).length,
		cameras: fixtureCounts(exifs.map(cameraLabel)),
		lenses: fixtureCounts(exifs.map((e) => e.lensModel)),
		focalLengths: fixtureBuckets(
			FIXTURE_GEAR_BUCKETS.focalLengths,
			exifs.map((e) => e.focalLength),
		),
		apertures: fixtureBuckets(
			FIXTURE_GEAR_BUCKETS.apertures,
			exifs.map((e) => fixtureAperture(e.aperture)),
		),
		shutterSpeeds: fixtureBuckets(
			FIXTURE_GEAR_BUCKETS.shutterSpeeds,
			exifs.map((e) => fixtureShutterSeconds(e.shutterSpeed)),
		),
		isos: fixtureBuckets(
			FIXTURE_GEAR_BUCKETS.isos,
			exifs.map((e) => e.iso),
		),
		cameraYears: [...cameraYears.values()].sort(
			(a, b) =>
				a.year - b.year ||
				b.count - a.count ||
				(a.camera < b.camera ? -1 : a.camera > b.camera ? 1 : 0),
		),
	};
}
