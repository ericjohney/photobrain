import { z } from "zod";

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
});

export const photoFiltersSchema = z.object({
	filterRaw: z.enum(["all", "raw", "standard"]).default("all"),
	folder: z.string().optional(),
	camera: z.string().optional(),
	lens: z.string().optional(),
	iso: z.coerce.number().int().optional(),
	dateMonth: z
		.string()
		.regex(/^\d{4}-(0[1-9]|1[0-2])$/)
		.optional(),
});

export const photoIdSchema = z.coerce.number().int().positive();

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
		filterRaw: photoFiltersSchema.shape.filterRaw,
		folder: photoFiltersSchema.shape.folder,
		camera: photoFiltersSchema.shape.camera,
		lens: photoFiltersSchema.shape.lens,
		iso: z.number().int().optional(),
		dateMonth: photoFiltersSchema.shape.dateMonth,
	})
	.strict();

export const searchResponseSchema = z.object({
	photos: z.array(photoSchema),
	total: z.number().int().nonnegative(),
	query: z.string(),
});

export const similarPhotosQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const similarPhotosResponseSchema = z.object({
	photos: z.array(photoSchema),
	total: z.number().int().nonnegative(),
	sourcePhotoId: z.number().int().positive(),
	indexed: z.boolean(),
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
