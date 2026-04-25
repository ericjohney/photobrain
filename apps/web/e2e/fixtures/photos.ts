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
	makePhoto(1, { name: "sunset.jpg", path: "photos/2024/sunset.jpg" }),
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
	}),
	makePhoto(5, {
		name: "street.jpg",
		path: "photos/2024/street.jpg",
		width: 4000,
		height: 6000,
	}),
	makePhoto(6, { name: "beach.jpg", path: "photos/2024/beach.jpg" }),
	makePhoto(7, {
		name: "mountain.heic",
		path: "photos/2024/mountain.heic",
		mimeType: "image/heic",
	}),
	makePhoto(8, { name: "forest.jpg", path: "photos/2024/forest.jpg" }),
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

export function searchPhotosByQuery(query: string): FixturePhoto[] {
	const q = query.toLowerCase();
	return FIXTURE_PHOTOS.filter(
		(p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
	);
}
