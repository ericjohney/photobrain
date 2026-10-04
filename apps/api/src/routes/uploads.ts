import { Hono } from "hono";
import type { ZodType } from "zod";
import type { ApiDatabase } from "../services/photo-catalog";
import {
	type FreeSpaceProbe,
	knownUploads,
	type MediaSupport,
	storeUpload,
	UploadError,
	type UploadErrorCode,
} from "../services/uploads";
import {
	errorResponseSchema,
	knownUploadsRequestSchema,
	knownUploadsResponseSchema,
	uploadConfigResponseSchema,
	uploadQuerySchema,
	uploadResultSchema,
} from "./v1-schemas";

export type UploadRouteDependencies = {
	database: ApiDatabase;
	photoDirectory: string;
	enabled: boolean;
	maxBytes: number;
	media: MediaSupport;
	freeBytes: FreeSpaceProbe;
	/** Sends `photos/uploaded` after a file is created; failures are logged only. */
	notifyUploaded: () => Promise<unknown>;
	/** Server clock for the `YYYY/MM` folder when `capturedAt` is absent. */
	now?: () => Date;
};

type ErrorStatus = 400 | 411 | 413 | 415 | 500 | 503 | 507;

const UPLOAD_ERROR_STATUS: Record<UploadErrorCode, ErrorStatus> = {
	UNSUPPORTED_MEDIA: 415,
	INSUFFICIENT_STORAGE: 507,
	UPLOAD_INCOMPLETE: 400,
};

function jsonResponse<T>(schema: ZodType<T>, value: unknown, status = 200) {
	return new Response(JSON.stringify(schema.parse(value)), {
		status,
		headers: { "Content-Type": "application/json; charset=UTF-8" },
	});
}

function errorResponse(code: string, message: string, status: ErrorStatus) {
	return jsonResponse(
		errorResponseSchema,
		{ error: { code, message } },
		status,
	);
}

function invalidRequest() {
	return errorResponse("INVALID_REQUEST", "Request validation failed", 400);
}

function uploadsDisabled() {
	return errorResponse("UPLOADS_DISABLED", "Uploads are disabled", 503);
}

/**
 * Phone backup upload routes, mounted at `/api/v1/uploads`. Uploaded originals
 * land under `{photoDirectory}/Uploads/` and are imported by the normal
 * incremental scan, which a debounced `photos/uploaded` event starts.
 */
export function createUploadsRouter(dependencies: UploadRouteDependencies) {
	const router = new Hono();

	router.get("/config", () => {
		try {
			return jsonResponse(uploadConfigResponseSchema, {
				enabled: dependencies.enabled,
				maxBytes: dependencies.maxBytes,
				extensions: dependencies.media
					.getSupportedExtensions()
					.map((extension) => extension.toLowerCase()),
			});
		} catch (error) {
			console.error("Upload config failed:", error);
			return errorResponse(
				"INTERNAL_ERROR",
				"The request could not be completed",
				500,
			);
		}
	});

	router.post("/known", async (context) => {
		if (!dependencies.enabled) return uploadsDisabled();
		let body: unknown;
		try {
			body = await context.req.raw.json();
		} catch {
			return invalidRequest();
		}
		const input = knownUploadsRequestSchema.safeParse(body);
		if (!input.success) return invalidRequest();
		try {
			return jsonResponse(knownUploadsResponseSchema, {
				assets: knownUploads(
					dependencies.database,
					input.data.deviceId,
					input.data.assetIds,
				),
			});
		} catch (error) {
			console.error("Known uploads lookup failed:", error);
			return errorResponse(
				"INTERNAL_ERROR",
				"The request could not be completed",
				500,
			);
		}
	});

	// Every check before `storeUpload` answers without reading the body.
	router.post("/", async (context) => {
		if (!dependencies.enabled) return uploadsDisabled();
		const request = context.req.raw;
		const lengthHeader = request.headers.get("content-length");
		if (lengthHeader === null) {
			return errorResponse(
				"LENGTH_REQUIRED",
				"Content-Length is required",
				411,
			);
		}
		if (!/^\d{1,16}$/.test(lengthHeader.trim())) return invalidRequest();
		const contentLength = Number(lengthHeader.trim());
		if (contentLength > dependencies.maxBytes) {
			return errorResponse(
				"UPLOAD_TOO_LARGE",
				`Uploads are limited to ${dependencies.maxBytes} bytes`,
				413,
			);
		}
		const query = uploadQuerySchema.safeParse(context.req.query());
		if (!query.success || contentLength === 0) return invalidRequest();

		try {
			const result = await storeUpload(
				dependencies,
				{ ...query.data, contentLength },
				request.body,
			);
			if (result.status === "duplicate") {
				return jsonResponse(uploadResultSchema, result);
			}
			try {
				await dependencies.notifyUploaded();
			} catch (error) {
				// The file is stored; the next upload or a manual scan imports it.
				console.error("photos/uploaded dispatch failed:", error);
			}
			return jsonResponse(uploadResultSchema, result, 201);
		} catch (error) {
			if (error instanceof UploadError) {
				return errorResponse(
					error.code,
					error.message,
					UPLOAD_ERROR_STATUS[error.code],
				);
			}
			console.error("Upload failed:", error);
			return errorResponse(
				"INTERNAL_ERROR",
				"The request could not be completed",
				500,
			);
		}
	});

	return router;
}
