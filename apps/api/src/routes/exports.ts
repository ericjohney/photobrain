import { Hono } from "hono";
import {
	CollectionError,
	type CollectionMembers,
	listCollectionMembers,
} from "../services/collections";
import {
	collectionZipStream,
	EXPORT_JPEG_QUALITY,
	EXPORT_SIZES,
	type ExportRenderer,
	type ExportSize,
	exportFilename,
} from "../services/exports";
import { NativeExecutorBusyError } from "../services/native-executor";
import type { ApiDatabase } from "../services/photo-catalog";
import { originalFilePath } from "../services/photo-files";
import { collectionIdSchema, photoIdSchema } from "./v1-schemas";

export type ExportDependencies = {
	database: ApiDatabase;
	photoDirectory: string;
	renderer: ExportRenderer;
};

/** Seconds a client should wait before retrying a busy single-photo render. */
const BUSY_RETRY_AFTER_SECONDS = 1;

/**
 * RFC 6266 `attachment` with an RFC 5987 UTF-8 `filename*` and a quoted ASCII
 * `filename` fallback in which every non-printable-ASCII code point, `"`, and
 * `\` becomes `_`.
 */
export function contentDisposition(filename: string): string {
	const fallback = filename.replace(/[^\x20-\x7e]|["\\]/gu, "_");
	// encodeURIComponent leaves ' ( ) * unescaped, but they are not RFC 5987 attr-chars.
	const encoded = encodeURIComponent(filename).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function errorResponse(
	code: string,
	message: string,
	status: 400 | 404 | 422 | 503,
	headers: Record<string, string> = {},
): Response {
	return Response.json(
		{ error: { code, message } },
		{ status, headers: { ...headers, "Cache-Control": "no-store" } },
	);
}

/** `size` query value, defaulting when absent; `null` when not an export size. */
function parseSize(value: string | undefined, fallback: ExportSize) {
	if (value === undefined) return fallback;
	return (EXPORT_SIZES as readonly string[]).includes(value)
		? (value as ExportSize)
		: null;
}

/**
 * Binary download routes, mounted at `/api`:
 * `GET /photos/:id/export` and `GET /collections/:id/export`.
 */
export function createExportsRouter(dependencies: ExportDependencies) {
	const { database, photoDirectory, renderer } = dependencies;
	const router = new Hono();

	router.get("/photos/:id/export", async (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		const size = parseSize(context.req.query("size"), "2048");
		if (!id.success || size === null)
			return errorResponse("INVALID_REQUEST", "Request validation failed", 400);
		const photo = await database.query.photos.findFirst({
			columns: { name: true, path: true, sourceRoot: true, mimeType: true },
			where: (photos, { eq }) => eq(photos.id, id.data),
		});
		if (!photo) return errorResponse("PHOTO_NOT_FOUND", "Photo not found", 404);
		const path = originalFilePath(photo, photoDirectory);
		const file = Bun.file(path);
		if (!(await file.exists())) {
			return errorResponse(
				"SOURCE_MISSING",
				"The original file is missing",
				404,
			);
		}
		const headers = {
			"Content-Disposition": contentDisposition(
				exportFilename(photo.name, size),
			),
			"Cache-Control": "private, no-store",
		};
		if (size === "original") {
			return new Response(file, {
				headers: {
					...headers,
					"Content-Type": photo.mimeType || "application/octet-stream",
					"Content-Length": String(file.size),
				},
			});
		}
		let jpeg: Uint8Array<ArrayBuffer>;
		try {
			jpeg = await renderer.run(
				"renderExportJpeg",
				path,
				Number(size),
				EXPORT_JPEG_QUALITY,
			);
		} catch (error) {
			if (error instanceof NativeExecutorBusyError) {
				return errorResponse(
					"EXPORT_BUSY",
					"The export renderer is busy; retry shortly",
					503,
					{ "Retry-After": String(BUSY_RETRY_AFTER_SECONDS) },
				);
			}
			console.error(`Export render failed for photo ${id.data}:`, error);
			return errorResponse(
				"EXPORT_FAILED",
				"The photo could not be rendered",
				422,
			);
		}
		return new Response(jpeg, {
			headers: {
				...headers,
				"Content-Type": "image/jpeg",
				"Content-Length": String(jpeg.byteLength),
			},
		});
	});

	router.get("/collections/:id/export", (context) => {
		const id = collectionIdSchema.safeParse(context.req.param("id"));
		const size = parseSize(context.req.query("size"), "original");
		if (!id.success || size === null)
			return errorResponse("INVALID_REQUEST", "Request validation failed", 400);
		let collection: CollectionMembers;
		try {
			collection = listCollectionMembers(database, id.data);
		} catch (error) {
			if (error instanceof CollectionError && error.code === "NOT_FOUND") {
				return errorResponse(
					"COLLECTION_NOT_FOUND",
					"Collection not found",
					404,
				);
			}
			throw error;
		}
		const stream = collectionZipStream(collection.members, {
			size,
			photoDirectory,
			renderer,
			signal: context.req.raw.signal,
		});
		return new Response(stream, {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": contentDisposition(`${collection.name}.zip`),
				"Cache-Control": "private, no-store",
			},
		});
	});

	return router;
}
