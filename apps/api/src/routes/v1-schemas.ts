import { z } from "zod";
import {
	type Collection,
	MAX_COLLECTION_NAME_LENGTH,
	MAX_COLLECTION_PHOTO_IDS,
} from "../services/collections";
import {
	DUPLICATE_ACTIONS,
	DUPLICATE_CURSOR_PATTERN,
	DUPLICATE_GROUPS_DEFAULT_LIMIT,
	DUPLICATE_GROUPS_MAX_LIMIT,
	DUPLICATE_KINDS,
	MAX_DUPLICATE_KEY_LENGTH,
} from "../services/duplicates";
import type { EventsResult } from "../services/events";
import type { GearStats } from "../services/gear-stats";
import {
	JUNK_ACTIONS,
	JUNK_REASONS,
	JUNK_REVIEW_DEFAULT_LIMIT,
	JUNK_REVIEW_MAX_LIMIT,
	MAX_JUNK_RESOLVE_IDS,
} from "../services/junk-review";
import type { OnThisDayResult } from "../services/on-this-day";
import {
	isValidCapturedDate,
	isValidPhotoBounds,
	type PhotoBounds,
	type PhotoLocationsResult,
} from "../services/photo-catalog";
import { MAX_CURATION_IDS } from "../services/photo-curation";
import { COUNTRY_CODE_PATTERN } from "../services/place-lookup";
import {
	MAX_SMART_ALBUM_NAME_LENGTH,
	MAX_SMART_ALBUM_QUERY_LENGTH,
	SMART_ALBUM_DATE_MONTH_PATTERN,
	type SmartAlbum,
} from "../services/smart-albums";
import {
	MAX_TAG_SLUG_LENGTH,
	TAG_SLUG_PATTERN,
} from "../services/tag-vocabulary";

export type FolderDto = {
	name: string;
	path: string;
	photoCount: number;
	children: FolderDto[];
};

export const folderSchema: z.ZodType<FolderDto> = z.lazy(() =>
	z.object({
		name: z.string(),
		path: z.string(),
		photoCount: z.number().int().nonnegative(),
		children: z.array(folderSchema),
	}),
);

export const foldersResponseSchema = z.object({
	folders: z.array(folderSchema),
	totalPhotos: z.number().int().nonnegative(),
});

export const filterOptionsQuerySchema = z.object({
	folder: z.string().optional(),
});

export const filterOptionsResponseSchema = z.object({
	cameras: z.array(z.string()),
	lenses: z.array(z.string()),
	isos: z.array(z.number().int()),
	dates: z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)),
	tags: z.array(
		z.object({
			tag: z.string(),
			count: z.number().int().positive(),
		}),
	),
	countries: z.array(
		z.object({
			code: z.string().regex(COUNTRY_CODE_PATTERN),
			name: z.string(),
			count: z.number().int().positive(),
		}),
	),
	places: z.array(
		z.object({
			id: z.number().int().positive(),
			name: z.string(),
			region: z.string().nullable(),
			countryCode: z.string().regex(COUNTRY_CODE_PATTERN),
			count: z.number().int().positive(),
		}),
	),
});

export const minRatingFilterSchema = z.coerce
	.number()
	.int()
	.min(1)
	.max(5)
	.optional();
export const curationFlagFilterSchema = z
	.enum(["pick", "reject", "unflagged"])
	.optional();
export const collectionIdFilterSchema = z.coerce
	.number()
	.int()
	.positive()
	.optional();
export const tagFilterSchema = z
	.string()
	.max(MAX_TAG_SLUG_LENGTH)
	.regex(TAG_SLUG_PATTERN)
	.optional();
export const countryFilterSchema = z
	.string()
	.regex(COUNTRY_CODE_PATTERN)
	.optional();
export const placeFilterSchema = z.coerce.number().int().positive().optional();
/** An `events` id (`event` filter); an unknown id matches nothing. */
export const eventFilterSchema = z.coerce.number().int().positive().optional();
/** A real `YYYY-MM-DD` calendar date (`capturedDate` filter, `onThisDay` `date`). */
export const calendarDateSchema = z.string().refine(isValidCapturedDate);
export const capturedDateFilterSchema = calendarDateSchema.optional();

/** `bounds` in JSON bodies; the same rule as tRPC and `isValidPhotoBounds`. */
export const photoBoundsSchema: z.ZodType<PhotoBounds> = z
	.object({
		north: z.number(),
		south: z.number(),
		east: z.number(),
		west: z.number(),
	})
	.strict()
	.refine(isValidPhotoBounds);

// Empty or non-numeric text fails instead of coercing to 0 or NaN.
const boundQueryParameterSchema = z
	.string()
	.trim()
	.min(1)
	.pipe(z.coerce.number().finite())
	.optional();

const photoFilterFieldsSchema = z.object({
	filterRaw: z.enum(["all", "raw", "standard"]).default("all"),
	folder: z.string().optional(),
	camera: z.string().optional(),
	lens: z.string().optional(),
	iso: z.coerce.number().int().optional(),
	dateMonth: z
		.string()
		.regex(/^\d{4}-(0[1-9]|1[0-2])$/)
		.optional(),
	minRating: minRatingFilterSchema,
	flag: curationFlagFilterSchema,
	collectionId: collectionIdFilterSchema,
	tag: tagFilterSchema,
	country: countryFilterSchema,
	place: placeFilterSchema,
	event: eventFilterSchema,
	capturedDate: capturedDateFilterSchema,
});

/**
 * `GET /photos` and `GET /locations` query: the filters plus `north`, `south`,
 * `east`, `west` (all four or none) folded into `bounds`.
 */
export const photoFiltersSchema = photoFilterFieldsSchema
	.extend({
		north: boundQueryParameterSchema,
		south: boundQueryParameterSchema,
		east: boundQueryParameterSchema,
		west: boundQueryParameterSchema,
	})
	.transform(({ north, south, east, west, ...filters }, context) => {
		if (
			north === undefined &&
			south === undefined &&
			east === undefined &&
			west === undefined
		) {
			return filters;
		}
		if (
			north === undefined ||
			south === undefined ||
			east === undefined ||
			west === undefined ||
			!isValidPhotoBounds({ north, south, east, west })
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					"north, south, east, west must all be given, finite, in range, and south <= north",
			});
			return z.NEVER;
		}
		return { ...filters, bounds: { north, south, east, west } };
	});

export const photoLocationsResponseSchema: z.ZodType<PhotoLocationsResult> =
	z.object({
		points: z.array(
			z.object({
				id: z.number().int().positive(),
				latitude: z.number().min(-90).max(90),
				longitude: z.number().min(-180).max(180),
			}),
		),
		total: z.number().int().nonnegative(),
	});

const gearCountSchema = z.object({
	label: z.string().min(1),
	count: z.number().int().positive(),
});

const gearBucketSchema = z.object({
	label: z.string(),
	min: z.number().nullable(),
	max: z.number().nullable(),
	count: z.number().int().nonnegative(),
});

/** `GET /gear-stats` (query: `photoFiltersSchema`); the service shape as is. */
export const gearStatsResponseSchema = z.object({
	total: z.number().int().nonnegative(),
	withExif: z.number().int().nonnegative(),
	cameras: z.array(gearCountSchema),
	lenses: z.array(gearCountSchema),
	focalLengths: z.array(gearBucketSchema),
	apertures: z.array(gearBucketSchema),
	shutterSpeeds: z.array(gearBucketSchema),
	isos: z.array(gearBucketSchema),
	cameraYears: z.array(
		z.object({
			camera: z.string().min(1),
			year: z.number().int().min(1900),
			count: z.number().int().positive(),
		}),
	),
}) satisfies z.ZodType<GearStats>;

export const photoIdSchema = z.coerce.number().int().positive();

export const photoFlagSchema = z.enum(["pick", "reject"]);

export const photoCurationPatchSchema = z
	.object({
		rating: z.number().int().min(0).max(5).optional(),
		flag: photoFlagSchema.nullable().optional(),
	})
	.strict()
	.refine((patch) => patch.rating !== undefined || patch.flag !== undefined);

export const photoExifSchema = z.object({
	id: z.number().int().positive(),
	photoId: z.number().int().positive(),
	cameraMake: z.string().nullable(),
	cameraModel: z.string().nullable(),
	lensMake: z.string().nullable(),
	lensModel: z.string().nullable(),
	focalLength: z.number().int().nullable(),
	iso: z.number().int().nullable(),
	aperture: z.string().nullable(),
	shutterSpeed: z.string().nullable(),
	exposureBias: z.string().nullable(),
	dateTaken: z.string().nullable(),
	gpsLatitude: z.string().nullable(),
	gpsLongitude: z.string().nullable(),
	gpsAltitude: z.string().nullable(),
});

const isoTimestampSchema = z.string().datetime();

export const photoSchema = z.object({
	id: z.number().int().positive(),
	path: z.string(),
	name: z.string(),
	size: z.number().int().nonnegative(),
	createdAt: isoTimestampSchema,
	modifiedAt: isoTimestampSchema,
	width: z.number().int().nullable(),
	height: z.number().int().nullable(),
	mimeType: z.string().nullable(),
	isRaw: z.boolean().nullable(),
	rawFormat: z.string().nullable(),
	rawStatus: z.string().nullable(),
	rawError: z.string().nullable(),
	thumbnailStatus: z.string().nullable(),
	thumbnailUpdatedAt: isoTimestampSchema.nullable(),
	embeddingStatus: z.string().nullable(),
	phashStatus: z.string().nullable(),
	rating: z.number().int().min(0).max(5),
	flag: photoFlagSchema.nullable(),
	/** RAW+JPEG pair partner's ID, or null when unpaired. */
	pairedPhotoId: z.number().int().positive().nullable(),
	/** Partner's `rawFormat` (RAW partner) or upper-cased extension, or null. */
	pairedFormat: z.string().nullable(),
	exif: photoExifSchema.nullable(),
});

export const photosResponseSchema = z.object({
	photos: z.array(photoSchema),
	total: z.number().int().nonnegative(),
	rawCount: z.number().int().nonnegative(),
});

export const searchRequestSchema = z
	.object({
		query: z.string().min(1),
		limit: z.number().int().min(1).max(100).default(20),
		filterRaw: photoFilterFieldsSchema.shape.filterRaw,
		folder: photoFilterFieldsSchema.shape.folder,
		camera: photoFilterFieldsSchema.shape.camera,
		lens: photoFilterFieldsSchema.shape.lens,
		iso: z.number().int().optional(),
		dateMonth: photoFilterFieldsSchema.shape.dateMonth,
		minRating: z.number().int().min(1).max(5).optional(),
		flag: curationFlagFilterSchema,
		collectionId: z.number().int().positive().optional(),
		tag: tagFilterSchema,
		country: countryFilterSchema,
		place: z.number().int().positive().optional(),
		event: z.number().int().positive().optional(),
		capturedDate: capturedDateFilterSchema,
		bounds: photoBoundsSchema.optional(),
	})
	.strict();

export const searchResponseSchema = z.object({
	photos: z.array(photoSchema),
	total: z.number().int().nonnegative(),
	query: z.string(),
});

export const similarPhotosQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(30),
	minRating: minRatingFilterSchema,
	flag: curationFlagFilterSchema,
	collectionId: collectionIdFilterSchema,
	tag: tagFilterSchema,
	country: countryFilterSchema,
	place: placeFilterSchema,
	event: eventFilterSchema,
	capturedDate: capturedDateFilterSchema,
});

export const photoTagsResponseSchema = z.object({
	tags: z.array(
		z.object({
			tag: z.string(),
			score: z.number().min(0).max(1),
		}),
	),
});

export const photoPlaceResponseSchema = z.object({
	place: z
		.object({
			id: z.number().int().positive(),
			city: z.string(),
			region: z.string().nullable(),
			country: z.string(),
			countryCode: z.string().regex(COUNTRY_CODE_PATTERN),
		})
		.nullable(),
});

export const similarPhotosResponseSchema = z.object({
	photos: z.array(photoSchema),
	total: z.number().int().nonnegative(),
	sourcePhotoId: z.number().int().positive(),
	indexed: z.boolean(),
});

export const junkReasonSchema = z.enum(JUNK_REASONS);

export const junkReviewQuerySchema = z.object({
	reason: junkReasonSchema.optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(JUNK_REVIEW_MAX_LIMIT)
		.default(JUNK_REVIEW_DEFAULT_LIMIT),
	cursor: z.coerce.number().int().positive().optional(),
});

export const junkReviewResponseSchema = z.object({
	photos: z.array(
		photoSchema.extend({ junkReasons: z.array(junkReasonSchema) }),
	),
	nextCursor: z.number().int().positive().nullable(),
	counts: z.object({
		all: z.number().int().nonnegative(),
		screenshot: z.number().int().nonnegative(),
		document: z.number().int().nonnegative(),
		blurry: z.number().int().nonnegative(),
		dark: z.number().int().nonnegative(),
	}),
});

export const resolveJunkRequestSchema = z
	.object({
		photoIds: z
			.array(z.number().int().positive())
			.min(1)
			.max(MAX_JUNK_RESOLVE_IDS),
		action: z.enum(JUNK_ACTIONS),
	})
	.strict();

export const resolveJunkResponseSchema = z.object({
	updated: z.array(z.number().int().positive()),
});

export const duplicateKindSchema = z.enum(DUPLICATE_KINDS);

export const duplicateGroupsQuerySchema = z.object({
	kind: duplicateKindSchema.optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(DUPLICATE_GROUPS_MAX_LIMIT)
		.default(DUPLICATE_GROUPS_DEFAULT_LIMIT),
	cursor: z.string().regex(DUPLICATE_CURSOR_PATTERN).optional(),
});

export const duplicateGroupsResponseSchema = z.object({
	groups: z.array(
		z.object({
			key: z.string().min(1),
			kind: duplicateKindSchema,
			photos: z.array(photoSchema).min(2),
			suggestedKeeperId: z.number().int().positive(),
			maxDistance: z.number().int().nonnegative().nullable(),
		}),
	),
	counts: z.object({
		duplicate: z.number().int().nonnegative(),
		burst: z.number().int().nonnegative(),
	}),
	nextCursor: z.string().regex(DUPLICATE_CURSOR_PATTERN).nullable(),
});

export const resolveDuplicateGroupRequestSchema = z
	.object({
		key: z.string().min(1).max(MAX_DUPLICATE_KEY_LENGTH),
		action: z.enum(DUPLICATE_ACTIONS),
		keepIds: z
			.array(z.number().int().positive())
			.max(MAX_CURATION_IDS)
			.optional(),
	})
	.strict();

export const resolveDuplicateGroupResponseSchema = z.union([
	z.object({ rejected: z.array(z.number().int().positive()) }).strict(),
	z.object({ dismissed: z.string().min(1) }).strict(),
]);

export const collectionIdSchema = z.coerce.number().int().positive();

const collectionNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_COLLECTION_NAME_LENGTH);

const collectionPhotoIdsSchema = z
	.array(z.number().int().positive())
	.min(1)
	.max(MAX_COLLECTION_PHOTO_IDS);

export const createCollectionRequestSchema = z
	.object({
		name: collectionNameSchema,
		photoIds: collectionPhotoIdsSchema.optional(),
	})
	.strict();

export const renameCollectionRequestSchema = z
	.object({ name: collectionNameSchema })
	.strict();

export const collectionPhotosRequestSchema = z
	.object({ photoIds: collectionPhotoIdsSchema })
	.strict();

export const collectionSchema = z.object({
	id: z.number().int().positive(),
	name: z.string().min(1).max(MAX_COLLECTION_NAME_LENGTH),
	photoCount: z.number().int().nonnegative(),
	cover: z
		.object({
			photoId: z.number().int().positive(),
			thumbnailUpdatedAt: isoTimestampSchema.nullable(),
		})
		.nullable(),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});

export const collectionsResponseSchema = z.object({
	collections: z.array(collectionSchema),
});

export const onThisDayQuerySchema = z.object({ date: calendarDateSchema });

export const onThisDayResponseSchema = z.object({
	date: calendarDateSchema,
	years: z.array(
		z.object({
			year: z.number().int().min(1900),
			yearsAgo: z.number().int().positive(),
			capturedDate: calendarDateSchema,
			count: z.number().int().positive(),
			cover: collectionSchema.shape.cover.unwrap(),
		}),
	),
});

export const eventsQuerySchema = z.object({ folder: z.string().optional() });

/** Capture wall clock without zone, `YYYY-MM-DDTHH:MM:SS`. */
const wallClockSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

export const eventsResponseSchema = z.object({
	events: z.array(
		z.object({
			id: z.number().int().positive(),
			startAt: wallClockSchema,
			endAt: wallClockSchema,
			photoCount: z.number().int().positive(),
			cover: collectionSchema.shape.cover.unwrap(),
			place: z
				.object({
					city: z.string().nullable(),
					region: z.string().nullable(),
					country: z.string(),
					countryCode: z.string().regex(COUNTRY_CODE_PATTERN),
				})
				.nullable(),
		}),
	),
});

export const addCollectionPhotosResponseSchema = z.object({
	added: z.number().int().nonnegative(),
	photoCount: z.number().int().nonnegative(),
});

export const removeCollectionPhotosResponseSchema = z.object({
	removed: z.number().int().nonnegative(),
	photoCount: z.number().int().nonnegative(),
});

export const photoCollectionsResponseSchema = z.object({
	collectionIds: z.array(z.number().int().positive()),
});

export const smartAlbumIdSchema = z.coerce.number().int().positive();

const smartAlbumNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_SMART_ALBUM_NAME_LENGTH);

const smartAlbumQuerySchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_SMART_ALBUM_QUERY_LENGTH)
	.nullable();

/**
 * Saved filters as accepted from clients: the photo filters minus
 * `collectionId` and the view scopes `bounds`, `capturedDate`, and `event`
 * (strict, so each is a 400).
 * Empty strings and `filterRaw: "all"` mean "no filter"; `dateMonth` accepts
 * `YYYY-MM` or the stored-EXIF `YYYY:MM`.
 */
export const smartAlbumFiltersRequestSchema = z
	.object({
		filterRaw: z.enum(["all", "raw", "standard"]).optional(),
		folder: z.string().optional(),
		camera: z.string().optional(),
		lens: z.string().optional(),
		iso: z.number().int().positive().optional(),
		dateMonth: z
			.union([z.literal(""), z.string().regex(SMART_ALBUM_DATE_MONTH_PATTERN)])
			.optional(),
		minRating: z.number().int().min(1).max(5).optional(),
		flag: curationFlagFilterSchema,
		tag: z.union([z.literal(""), tagFilterSchema.unwrap()]).optional(),
		country: z.union([z.literal(""), countryFilterSchema.unwrap()]).optional(),
		place: z.number().int().positive().optional(),
	})
	.strict();

export const createSmartAlbumRequestSchema = z
	.object({
		name: smartAlbumNameSchema,
		filters: smartAlbumFiltersRequestSchema,
		query: smartAlbumQuerySchema.optional(),
	})
	.strict();

export const updateSmartAlbumRequestSchema = z
	.object({
		name: smartAlbumNameSchema.optional(),
		filters: smartAlbumFiltersRequestSchema.optional(),
		query: smartAlbumQuerySchema.optional(),
	})
	.strict();

export const smartAlbumSchema = z.object({
	id: z.number().int().positive(),
	name: z.string().min(1).max(MAX_SMART_ALBUM_NAME_LENGTH),
	filters: z
		.object({
			filterRaw: z.enum(["raw", "standard"]).optional(),
			folder: z.string().min(1).optional(),
			camera: z.string().min(1).optional(),
			lens: z.string().min(1).optional(),
			iso: z.number().int().positive().optional(),
			dateMonth: photoFilterFieldsSchema.shape.dateMonth,
			minRating: z.number().int().min(1).max(5).optional(),
			flag: curationFlagFilterSchema,
			tag: tagFilterSchema,
			country: countryFilterSchema,
			place: z.number().int().positive().optional(),
		})
		.strict(),
	query: z.string().min(1).max(MAX_SMART_ALBUM_QUERY_LENGTH).nullable(),
	photoCount: z.number().int().nonnegative().nullable(),
	cover: collectionSchema.shape.cover,
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});

export const smartAlbumsResponseSchema = z.object({
	albums: z.array(smartAlbumSchema),
});

export const startScanRequestSchema = z
	.object({ force: z.boolean().default(false) })
	.strict();

export const PUBLIC_SCAN_START_ERROR = "The scan could not be started";
export const PUBLIC_SCAN_FAILURE_ERROR = "The scan could not be completed";

const startScanSuccessSchema = z.object({
	success: z.literal(true),
	jobId: z.string().uuid(),
});

const startScanFailureSchema = z.object({
	success: z.literal(false),
	error: z.literal(PUBLIC_SCAN_START_ERROR),
	jobId: z.string().uuid().optional(),
});

export const startScanResponseSchema = z.discriminatedUnion("success", [
	startScanSuccessSchema,
	startScanFailureSchema,
]);

export const scanIdSchema = z.string().uuid();

export const scanPhaseSchema = z.enum([
	"queued",
	"discovering",
	"processing",
	"scan-complete",
	"embedding",
	"completed",
	"failed",
]);

export const scanStatusSchema = z.enum([
	"queued",
	"running",
	"completed",
	"failed",
]);

export const scanSchema = z.object({
	id: z.string().uuid(),
	phase: scanPhaseSchema,
	current: z.number().int().nonnegative(),
	total: z.number().int().nonnegative(),
	status: scanStatusSchema,
	error: z.string().nullable(),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
});

export const scanStatusResponseSchema = scanSchema.nullable();

export const activeScansResponseSchema = z.object({
	jobs: z.array(scanSchema),
});

export const errorResponseSchema = z.object({
	error: z.object({
		code: z.string().min(1),
		message: z.string().min(1),
	}),
});

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Expected an object for API serialization");
	}
	return value as Record<string, unknown>;
}

function toIsoTimestamp(value: unknown): string {
	const date =
		value instanceof Date ? value : new Date(value as string | number);
	if (Number.isNaN(date.getTime()))
		throw new TypeError("Invalid API timestamp");
	return date.toISOString();
}

function toNullableIsoTimestamp(value: unknown): string | null {
	return value === null || value === undefined ? null : toIsoTimestamp(value);
}

export function serializePhoto(value: unknown) {
	const record = asRecord(value);
	return {
		...record,
		createdAt: toIsoTimestamp(record.createdAt),
		modifiedAt: toIsoTimestamp(record.modifiedAt),
		thumbnailUpdatedAt: toNullableIsoTimestamp(record.thumbnailUpdatedAt),
	};
}

function serializeScanPhase(value: unknown): z.infer<typeof scanPhaseSchema> {
	switch (value) {
		case "queued":
		case "discovering":
		case "processing":
		case "scan-complete":
		case "embedding":
		case "completed":
		case "failed":
			return value;
		default:
			throw new TypeError("Invalid persisted scan phase");
	}
}

function serializeScanStatus(value: unknown): z.infer<typeof scanStatusSchema> {
	switch (value) {
		case "queued":
		case "running":
		case "completed":
		case "failed":
			return value;
		default:
			throw new TypeError("Invalid persisted scan status");
	}
}

export function serializeScan(value: unknown) {
	const record = asRecord(value);
	return {
		...record,
		phase: serializeScanPhase(record.phase),
		status: serializeScanStatus(record.status),
		error:
			record.error === null || record.error === undefined
				? null
				: PUBLIC_SCAN_FAILURE_ERROR,
		createdAt: toIsoTimestamp(record.createdAt),
		updatedAt: toIsoTimestamp(record.updatedAt),
	};
}

export function serializePhotosResponse(value: {
	photos: readonly unknown[];
	total: number;
	rawCount: number;
}) {
	return {
		...value,
		photos: value.photos.map(serializePhoto),
	};
}

export function serializeSearchResponse(value: {
	photos: readonly unknown[];
	total: number;
	query: string;
}) {
	return {
		...value,
		photos: value.photos.map(serializePhoto),
	};
}

export function serializeSimilarPhotosResponse(value: {
	photos: readonly unknown[];
	total: number;
	sourcePhotoId: number;
	indexed: boolean;
}) {
	return {
		...value,
		photos: value.photos.map(serializePhoto),
	};
}

export function serializeJunkReviewResponse(value: {
	photos: readonly unknown[];
	nextCursor: number | null;
	counts: Record<string, number>;
}) {
	return {
		...value,
		photos: value.photos.map(serializePhoto),
	};
}

export function serializeDuplicateGroupsResponse(value: {
	groups: readonly { photos: readonly unknown[] }[];
	counts: Record<string, number>;
	nextCursor: string | null;
}) {
	return {
		...value,
		groups: value.groups.map((group) => ({
			...group,
			photos: group.photos.map(serializePhoto),
		})),
	};
}

export function serializeCollection(value: Collection) {
	return {
		...value,
		cover: value.cover && {
			photoId: value.cover.photoId,
			thumbnailUpdatedAt: toNullableIsoTimestamp(
				value.cover.thumbnailUpdatedAt,
			),
		},
		createdAt: toIsoTimestamp(value.createdAt),
		updatedAt: toIsoTimestamp(value.updatedAt),
	};
}

export function serializeSmartAlbum(value: SmartAlbum) {
	return {
		...value,
		cover: value.cover && {
			photoId: value.cover.photoId,
			thumbnailUpdatedAt: toNullableIsoTimestamp(
				value.cover.thumbnailUpdatedAt,
			),
		},
		createdAt: toIsoTimestamp(value.createdAt),
		updatedAt: toIsoTimestamp(value.updatedAt),
	};
}

export function serializeOnThisDay(value: OnThisDayResult) {
	return {
		date: value.date,
		years: value.years.map((group) => ({
			...group,
			cover: {
				photoId: group.cover.photoId,
				thumbnailUpdatedAt: toNullableIsoTimestamp(
					group.cover.thumbnailUpdatedAt,
				),
			},
		})),
	};
}

export function serializeEvents(value: EventsResult) {
	return {
		events: value.events.map((event) => ({
			...event,
			cover: {
				photoId: event.cover.photoId,
				thumbnailUpdatedAt: toNullableIsoTimestamp(
					event.cover.thumbnailUpdatedAt,
				),
			},
		})),
	};
}
