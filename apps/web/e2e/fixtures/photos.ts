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

export const FIXTURE_PHOTOS: FixturePhoto[] = [
	makePhoto(1, {
		name: "sunset.jpg",
		path: "photos/2024/sunset.jpg",
		rating: 5,
		flag: "pick",
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
	}),
	makePhoto(7, {
		name: "mountain.heic",
		path: "photos/2024/mountain.heic",
		mimeType: "image/heic",
	}),
	makePhoto(8, {
		name: "forest.jpg",
		path: "photos/2024/forest.jpg",
		rating: 4,
		flag: "pick",
	}),
	makePhoto(9, { name: "city.jpg", path: "photos/2024/city.jpg" }),
	makePhoto(10, { name: "flower.jpg", path: "photos/2024/flower.jpg" }),
	makePhoto(11, { name: "cat.jpg", path: "photos/2024/cat.jpg", exif: null }),
	makePhoto(12, { name: "dog.jpg", path: "photos/2024/dog.jpg" }),
];

export const FIXTURE_FOLDERS = {
	folders: [
		{ name: "2024", path: "photos/2024", photoCount: 12, children: [] },
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

export function searchPhotosByQuery(
	query: string,
	photos: FixturePhoto[] = FIXTURE_PHOTOS,
): FixturePhoto[] {
	const q = query.toLowerCase();
	return photos.filter(
		(p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
	);
}

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
};

/** Camera label as the API composes it: model alone when it already starts with the make. */
function cameraLabel(exif: NonNullable<FixturePhoto["exif"]>) {
	if (!exif.cameraMake || !exif.cameraModel) return null;
	return exif.cameraModel.startsWith(exif.cameraMake)
		? exif.cameraModel
		: `${exif.cameraMake} ${exif.cameraModel}`;
}

/** Mirrors the API's shared library/search filter semantics (folder = direct children only). */
export function filterFixturePhotos(
	photos: FixturePhoto[],
	filters: FixturePhotoFilters = {},
): FixturePhoto[] {
	return photos.filter((p) => {
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
		return true;
	});
}
