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
	thumbnailStatus: string;
	embeddingStatus: string;
	phashStatus: string;
	rating: number;
	flag: "pick" | "reject" | null;
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
	makePhoto(5, {
		name: "street.jpg",
		path: "photos/2024/street.jpg",
		width: 4000,
		height: 6000,
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
		exif: { ...makePhoto(7).exif!, ...gps("-17.7134", "178.065") },
	}),
	makePhoto(8, {
		name: "forest.jpg",
		path: "photos/2024/forest.jpg",
		rating: 4,
		flag: "pick",
		pairedPhotoId: 13,
		pairedFormat: "ARW",
		exif: { ...makePhoto(8).exif!, ...gps("47.6062", "-122.3321") },
	}),
	makePhoto(9, {
		name: "city.jpg",
		path: "photos/2024/city.jpg",
		exif: { ...makePhoto(9).exif!, ...gps("-13.8333", "-171.7667") },
	}),
	// Invalid locations the map ignores: non-numeric text and the 0,0 default.
	makePhoto(10, {
		name: "flower.jpg",
		path: "photos/2024/flower.jpg",
		exif: { ...makePhoto(10).exif!, ...gps("unknown", "12.5") },
	}),
	makePhoto(11, { name: "cat.jpg", path: "photos/2024/cat.jpg", exif: null }),
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
		exif: { ...makePhoto(13).exif!, ...gps("47.6062", "-122.3321") },
	}),
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
	filterRaw?: "all" | "raw" | "standard";
	camera?: string;
	lens?: string;
	iso?: number;
	dateMonth?: string;
	minRating?: number;
	flag?: "pick" | "reject" | "unflagged";
	tag?: string;
	country?: string;
	place?: number;
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
 * `raw` (or a collection holding only the RAW) shows the RAW.
 */
export function filterFixturePhotos(
	photos: FixturePhoto[],
	filters: FixturePhotoFilters = {},
): FixturePhoto[] {
	const matching = photos.filter((p) => {
		if (
			filters.folder !== undefined &&
			p.path.slice(0, p.path.lastIndexOf("/")) !== filters.folder
		) {
			return false;
		}
		if (filters.filterRaw === "raw" && !p.isRaw) return false;
		if (filters.filterRaw === "standard" && p.isRaw) return false;
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
