import type { DevelopedRawOptions } from "@photobrain/image-processing";
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
	type RawDeveloper,
} from "../services/exports";
import { NativeExecutorBusyError } from "../services/native-executor";
import type { ApiDatabase } from "../services/photo-catalog";
import { originalFilePath } from "../services/photo-files";
import { collectionIdSchema, photoIdSchema } from "./v1-schemas";

export type ExportDependencies = {
	database: ApiDatabase;
	photoDirectory: string;
	renderer: ExportRenderer;
	/** Optional: enables `GET /photos/:id/developed`. */
	developer?: RawDeveloper;
	/** Server-owned settings for the Developed view (Apple by default). */
	rawDevelop?: DevelopedRawOptions;
};

/** JPEG quality of developed RAW renders (near-lossless for loupe inspection). */
const DEVELOPED_JPEG_QUALITY = 95;

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
	const { database, photoDirectory, renderer, developer } = dependencies;
	const rawDevelop = dependencies.rawDevelop ?? { engine: "apple" };
	const router = new Hono();

	router.get("/photos/:id/export", async (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		const requestedSize = parseSize(context.req.query("size"), "2048");
		if (!id.success || requestedSize === null)
			return errorResponse("INVALID_REQUEST", "Request validation failed", 400);
		const photo = await database.query.photos.findFirst({
			columns: {
				name: true,
				path: true,
				sourceRoot: true,
				mimeType: true,
				mediaType: true,
			},
			where: (photos, { eq }) => eq(photos.id, id.data),
		});
		if (!photo) return errorResponse("PHOTO_NOT_FOUND", "Photo not found", 404);
		// Videos are never rendered: every size streams the original.
		const size = photo.mediaType === "video" ? "original" : requestedSize;
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

	// Full RAW development (raw-develop) for the loupe's "Developed" view: a
	// full-resolution Display P3 JPEG, rendered on demand and not cached.
	router.get("/photos/:id/developed", async (context) => {
		const id = photoIdSchema.safeParse(context.req.param("id"));
		if (!id.success)
			return errorResponse("INVALID_REQUEST", "Request validation failed", 400);
		if (!developer)
			return errorResponse(
				"DEVELOP_UNAVAILABLE",
				"RAW development is off",
				503,
			);
		const photo = await database.query.photos.findFirst({
			columns: { path: true, sourceRoot: true, isRaw: true },
			where: (photos, { eq }) => eq(photos.id, id.data),
		});
		if (!photo) return errorResponse("PHOTO_NOT_FOUND", "Photo not found", 404);
		if (!photo.isRaw)
			return errorResponse("NOT_RAW", "Only RAW photos can be developed", 422);
		const path = originalFilePath(photo, photoDirectory);
		if (!(await Bun.file(path).exists())) {
			return errorResponse(
				"SOURCE_MISSING",
				"The original file is missing",
				404,
			);
		}
		let developed: {
			jpeg: Uint8Array<ArrayBuffer>;
			width: number;
			height: number;
			engine: "apple" | "adobe";
		};
		// A client that navigates away aborts its request; withdraw the render if it
		// has not started, so queued renders for photos no longer on screen do not
		// delay the one the user is waiting for.
		const signal = context.req.raw.signal;
		try {
			developed = await developer.runCancellable(
				signal,
				"renderDevelopedRaw",
				path,
				DEVELOPED_JPEG_QUALITY,
				rawDevelop,
			);
		} catch (error) {
			if (signal.aborted) {
				// Nobody is listening; any status will do.
				return new Response(null, { status: 499 });
			}
			if (error instanceof NativeExecutorBusyError) {
				return errorResponse(
					"DEVELOP_BUSY",
					"The renderer is busy; retry shortly",
					503,
					{ "Retry-After": String(BUSY_RETRY_AFTER_SECONDS) },
				);
			}
			console.error(`RAW develop failed for photo ${id.data}:`, error);
			return errorResponse(
				"DEVELOP_UNSUPPORTED",
				error instanceof Error
					? error.message
					: "The RAW could not be developed",
				422,
			);
		}
		return new Response(developed.jpeg, {
			headers: {
				"Content-Type": "image/jpeg",
				"Content-Length": String(developed.jpeg.byteLength),
				"Cache-Control": "private, no-store",
				"X-Developed-Width": String(developed.width),
				"X-Developed-Height": String(developed.height),
				"X-Developed-Engine": developed.engine,
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
