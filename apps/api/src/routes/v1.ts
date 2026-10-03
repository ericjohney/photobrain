import { Hono } from "hono";
import type { ZodType } from "zod";
import type { ApiDatabase } from "../services/photo-catalog";
import {
	getPhoto,
	listFilterOptions,
	listFolders,
	listPhotos,
} from "../services/photo-catalog";
import type { PhotoSearchProvider } from "../services/photo-search";
import { searchPhotoCatalog } from "../services/photo-search";
import type { ScanEventDispatcher } from "../services/scan-jobs";
import { getScan, listActiveScans, startScan } from "../services/scan-jobs";
import { findSimilarToPhoto } from "../services/vector-search";
import {
	activeScansResponseSchema,
	errorResponseSchema,
	filterOptionsQuerySchema,
	filterOptionsResponseSchema,
	foldersResponseSchema,
	PUBLIC_SCAN_START_ERROR,
	photoFiltersSchema,
	photoIdSchema,
	photoSchema,
	photosResponseSchema,
	scanIdSchema,
	scanStatusResponseSchema,
	searchRequestSchema,
	searchResponseSchema,
	serializePhoto,
	serializePhotosResponse,
	serializeScan,
	serializeSearchResponse,
	serializeSimilarPhotosResponse,
	similarPhotosQuerySchema,
	similarPhotosResponseSchema,
	startScanRequestSchema,
	startScanResponseSchema,
} from "./v1-schemas";

export type V1Dependencies = {
	database: ApiDatabase;
	searchPhotos: PhotoSearchProvider;
	dispatchScan: ScanEventDispatcher;
	photoDirectory: string;
	thumbnailsDirectory: string;
	nativeScanMutationsEnabled: boolean;
};

type ErrorStatus = 400 | 404 | 500 | 503;

function jsonResponse<T>(schema: ZodType<T>, value: unknown, status = 200) {
	const body = schema.parse(value);
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=UTF-8" },
	});
}

function errorResponse(
	code: string,
	message: string,
	status: ErrorStatus,
): Response {
	return jsonResponse(
		errorResponseSchema,
		{ error: { code, message } },
		status,
	);
}

async function readJsonBody(request: Request, allowEmpty: boolean) {
	const text = await request.text();
	if (allowEmpty && text.trim().length === 0) return {};
	return JSON.parse(text) as unknown;
}

function invalidRequest(): Response {
	return errorResponse("INVALID_REQUEST", "Request validation failed", 400);
}

function internalError(error: unknown): Response {
	console.error("API v1 request failed:", error);
	return errorResponse(
		"INTERNAL_ERROR",
		"The request could not be completed",
		500,
	);
}

export function createV1Router(dependencies: V1Dependencies) {
	const router = new Hono();

	router.get("/folders", async () => {
		try {
			return jsonResponse(
				foldersResponseSchema,
				await listFolders(dependencies.database),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/filter-options", async (context) => {
		const input = filterOptionsQuerySchema.safeParse(context.req.query());
		if (!input.success) return invalidRequest();
		try {
			return jsonResponse(
				filterOptionsResponseSchema,
				await listFilterOptions(dependencies.database, input.data, {
					normalizeDateMonths: true,
				}),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/photos", async (context) => {
		const input = photoFiltersSchema.safeParse(context.req.query());
		if (!input.success) return invalidRequest();
		try {
			const result = await listPhotos(dependencies.database, input.data, {
				normalizeDateMonths: true,
			});
			return jsonResponse(
				photosResponseSchema,
				serializePhotosResponse(result),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/photos/:id/similar", async (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		const query = similarPhotosQuerySchema.safeParse(context.req.query());
		if (!id.success || !query.success) return invalidRequest();
		try {
			const result = await findSimilarToPhoto(
				dependencies.database,
				id.data,
				query.data.limit,
			);
			if (!result) {
				return errorResponse("PHOTO_NOT_FOUND", "Photo not found", 404);
			}
			return jsonResponse(
				similarPhotosResponseSchema,
				serializeSimilarPhotosResponse(result),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/photos/:id", async (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		if (!id.success) return invalidRequest();
		try {
			const photo = await getPhoto(dependencies.database, id.data);
			if (!photo) {
				return errorResponse("PHOTO_NOT_FOUND", "Photo not found", 404);
			}
			return jsonResponse(photoSchema, serializePhoto(photo));
		} catch (error) {
			return internalError(error);
		}
	});

	router.post("/search", async (context) => {
		let body: unknown;
		try {
			body = await readJsonBody(context.req.raw, false);
		} catch {
			return invalidRequest();
		}
		const input = searchRequestSchema.safeParse(body);
		if (!input.success) return invalidRequest();
		try {
			const result = await searchPhotoCatalog(
				dependencies.searchPhotos,
				input.data,
				{ normalizeDateMonths: true },
			);
			return jsonResponse(
				searchResponseSchema,
				serializeSearchResponse(result),
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.post("/scans", async (context) => {
		if (!dependencies.nativeScanMutationsEnabled) {
			return errorResponse(
				"NATIVE_SCAN_DISABLED",
				"Native scan mutations are disabled",
				503,
			);
		}

		let body: unknown;
		try {
			body = await readJsonBody(context.req.raw, true);
		} catch {
			return invalidRequest();
		}
		const input = startScanRequestSchema.safeParse(body);
		if (!input.success) return invalidRequest();

		try {
			const result = await startScan(
				dependencies.database,
				dependencies.dispatchScan,
				{
					force: input.data.force,
					photoDirectory: dependencies.photoDirectory,
					thumbnailsDirectory: dependencies.thumbnailsDirectory,
				},
			);
			if (result.success) {
				return jsonResponse(startScanResponseSchema, result);
			}
			return jsonResponse(startScanResponseSchema, {
				success: false,
				error: PUBLIC_SCAN_START_ERROR,
				...(result.jobId ? { jobId: result.jobId } : {}),
			});
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/scans/active", async () => {
		try {
			const jobs = await listActiveScans(dependencies.database);
			return jsonResponse(activeScansResponseSchema, {
				jobs: jobs.map(serializeScan),
			});
		} catch (error) {
			return internalError(error);
		}
	});

	router.get("/scans/:jobId", async (context) => {
		const jobId = scanIdSchema.safeParse(context.req.param("jobId"));
		if (!jobId.success) return invalidRequest();
		try {
			const job = await getScan(dependencies.database, jobId.data);
			return jsonResponse(
				scanStatusResponseSchema,
				job ? serializeScan(job) : null,
			);
		} catch (error) {
			return internalError(error);
		}
	});

	router.notFound(() =>
		errorResponse("NOT_FOUND", "API v1 route not found", 404),
	);

	return router;
}
