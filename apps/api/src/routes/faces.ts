import type { FaceBox } from "@photobrain/image-processing";
import { Hono } from "hono";
import {
	FACE_CROP_DEFAULT_SIZE,
	FACE_CROP_SIZES,
	getFaceCropSource,
} from "../services/faces";
import { NativeExecutorBusyError } from "../services/native-executor";
import type { ApiDatabase } from "../services/photo-catalog";
import { faceIdSchema } from "./v1-schemas";

/**
 * The native face-crop render the route needs; the shared `NativeExecutor`
 * satisfies it and rejects with `NativeExecutorBusyError` at its admission limit.
 */
export type FaceCropRenderer = {
	run(
		operation: "renderFaceCrop",
		path: string,
		box: FaceBox,
		size: number,
	): Promise<Uint8Array<ArrayBuffer>>;
};

export type FaceRouteDependencies = {
	database: ApiDatabase;
	thumbnailsDirectory: string;
	renderer: FaceCropRenderer;
};

/** Seconds a client should wait before retrying a busy crop render. */
const BUSY_RETRY_AFTER_SECONDS = 1;

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

/**
 * `GET /faces/:id/crop?size=128|256` (default 256), mounted at `/api`: a square
 * WebP of the face rendered from the `large` thumbnail of the face's own
 * generation. The generation is part of the ETag, so responses are immutable.
 */
export function createFacesRouter(dependencies: FaceRouteDependencies) {
	const { database, thumbnailsDirectory, renderer } = dependencies;
	const router = new Hono();

	router.get("/faces/:id/crop", async (context) => {
		const id = faceIdSchema.safeParse(context.req.param("id"));
		const sizeText = context.req.query("size");
		const size =
			sizeText === undefined
				? FACE_CROP_DEFAULT_SIZE
				: FACE_CROP_SIZES.find((candidate) => String(candidate) === sizeText);
		if (!id.success || size === undefined) {
			return errorResponse("INVALID_REQUEST", "Request validation failed", 400);
		}
		const source = getFaceCropSource(database, id.data, thumbnailsDirectory);
		if (!source) return errorResponse("FACE_NOT_FOUND", "Face not found", 404);
		const headers = {
			"Cache-Control": "public, max-age=31536000, immutable",
			ETag: `"face-${id.data}-${source.thumbnailKey}-${size}"`,
		};
		if (context.req.header("If-None-Match") === headers.ETag) {
			return new Response(null, { status: 304, headers });
		}
		if (!(await Bun.file(source.path).exists())) {
			return errorResponse(
				"FACE_NOT_FOUND",
				"The face's thumbnail is missing",
				404,
			);
		}
		let webp: Uint8Array<ArrayBuffer>;
		try {
			webp = await renderer.run(
				"renderFaceCrop",
				source.path,
				source.box,
				size,
			);
		} catch (error) {
			if (error instanceof NativeExecutorBusyError) {
				return errorResponse(
					"FACE_BUSY",
					"The face renderer is busy; retry shortly",
					503,
					{ "Retry-After": String(BUSY_RETRY_AFTER_SECONDS) },
				);
			}
			console.error(`Face crop failed for face ${id.data}:`, error);
			return errorResponse(
				"FACE_CROP_FAILED",
				"The face could not be rendered",
				422,
			);
		}
		return new Response(webp, {
			headers: {
				...headers,
				"Content-Type": "image/webp",
				"Content-Length": String(webp.byteLength),
			},
		});
	});

	return router;
}
