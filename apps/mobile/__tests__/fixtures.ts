export type MockPhoto = {
	id: number;
	path: string;
	name: string;
	size: number;
	width: number;
	height: number;
	mimeType: string;
	createdAt: string;
	modifiedAt: string;
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

export const MOCK_PHOTOS: MockPhoto[] = [
	{
		id: 1,
		path: "photos/2024/sunset.jpg",
		name: "sunset.jpg",
		size: 4500000,
		width: 6000,
		height: 4000,
		mimeType: "image/jpeg",
		createdAt: "2024-06-15T18:30:00.000Z",
		modifiedAt: "2024-06-15T18:30:00.000Z",
		isRaw: false,
		rawFormat: null,
		rawStatus: null,
		rawError: null,
		thumbnailStatus: "completed",
		embeddingStatus: "completed",
		phashStatus: "completed",
		exif: {
			id: 1, photoId: 1,
			cameraMake: "Sony", cameraModel: "A7III",
			lensMake: "Sony", lensModel: "FE 24-70mm f/2.8 GM",
			focalLength: 35, iso: 100, aperture: "f/8",
			shutterSpeed: "1/250", exposureBias: "0",
			dateTaken: "2024-06-15T18:30:00.000Z",
			gpsLatitude: null, gpsLongitude: null, gpsAltitude: null,
		},
	},
	{
		id: 2,
		path: "photos/2024/portrait.arw",
		name: "portrait.arw",
		size: 25000000,
		width: 6000,
		height: 4000,
		mimeType: "image/x-sony-arw",
		createdAt: "2024-06-15T14:00:00.000Z",
		modifiedAt: "2024-06-15T14:00:00.000Z",
		isRaw: true,
		rawFormat: "ARW",
		rawStatus: "converted",
		rawError: null,
		thumbnailStatus: "completed",
		embeddingStatus: "completed",
		phashStatus: "completed",
		exif: {
			id: 2, photoId: 2,
			cameraMake: "Sony", cameraModel: "A7III",
			lensMake: "Sony", lensModel: "FE 85mm f/1.4 GM",
			focalLength: 85, iso: 400, aperture: "f/1.4",
			shutterSpeed: "1/500", exposureBias: "+0.3",
			dateTaken: "2024-06-15T14:00:00.000Z",
			gpsLatitude: null, gpsLongitude: null, gpsAltitude: null,
		},
	},
	{
		id: 3,
		path: "photos/2024/landscape.jpg",
		name: "landscape.jpg",
		size: 8000000,
		width: 7360,
		height: 4912,
		mimeType: "image/jpeg",
		createdAt: "2024-07-20T08:15:00.000Z",
		modifiedAt: "2024-07-20T08:15:00.000Z",
		isRaw: false,
		rawFormat: null,
		rawStatus: null,
		rawError: null,
		thumbnailStatus: "completed",
		embeddingStatus: "completed",
		phashStatus: "completed",
		exif: {
			id: 3, photoId: 3,
			cameraMake: "Canon", cameraModel: "EOS R5",
			lensMake: "Canon", lensModel: "RF 15-35mm f/2.8L IS USM",
			focalLength: 15, iso: 200, aperture: "f/11",
			shutterSpeed: "1/125", exposureBias: "-0.7",
			dateTaken: "2024-07-20T08:15:00.000Z",
			gpsLatitude: "37.7749", gpsLongitude: "-122.4194", gpsAltitude: "52",
		},
	},
	{
		id: 4,
		path: "photos/2024/macro.cr2",
		name: "macro.cr2",
		size: 30000000,
		width: 5472,
		height: 3648,
		mimeType: "image/x-canon-cr2",
		createdAt: "2024-07-20T10:30:00.000Z",
		modifiedAt: "2024-07-20T10:30:00.000Z",
		isRaw: true,
		rawFormat: "CR2",
		rawStatus: "converted",
		rawError: null,
		thumbnailStatus: "completed",
		embeddingStatus: "completed",
		phashStatus: "completed",
		exif: {
			id: 4, photoId: 4,
			cameraMake: "Canon", cameraModel: "EOS R5",
			lensMake: "Canon", lensModel: "RF 100mm f/2.8L Macro IS USM",
			focalLength: 100, iso: 800, aperture: "f/5.6",
			shutterSpeed: "1/200", exposureBias: "0",
			dateTaken: "2024-07-20T10:30:00.000Z",
			gpsLatitude: null, gpsLongitude: null, gpsAltitude: null,
		},
	},
	{
		id: 5,
		path: "photos/2024/street.jpg",
		name: "street.jpg",
		size: 3200000,
		width: 4000,
		height: 6000,
		mimeType: "image/jpeg",
		createdAt: "2024-08-05T20:45:00.000Z",
		modifiedAt: "2024-08-05T20:45:00.000Z",
		isRaw: false,
		rawFormat: null,
		rawStatus: null,
		rawError: null,
		thumbnailStatus: "completed",
		embeddingStatus: "completed",
		phashStatus: "completed",
		exif: {
			id: 5, photoId: 5,
			cameraMake: "Fujifilm", cameraModel: "X-T5",
			lensMake: "Fujifilm", lensModel: "XF 23mm f/1.4 R LM WR",
			focalLength: 23, iso: 3200, aperture: "f/1.4",
			shutterSpeed: "1/60", exposureBias: "+1",
			dateTaken: "2024-08-05T20:45:00.000Z",
			gpsLatitude: null, gpsLongitude: null, gpsAltitude: null,
		},
	},
];

export const SEARCH_RESULTS_PHOTOS = [MOCK_PHOTOS[0], MOCK_PHOTOS[2]];
