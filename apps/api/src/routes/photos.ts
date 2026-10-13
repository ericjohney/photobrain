import { join } from "node:path";
import {
	getThumbnailPath,
	THUMBNAIL_CONFIG,
	type ThumbnailSize,
} from "@photobrain/utils";
import type { BunFile } from "bun";
import { Hono } from "hono";
import { config } from "../config";
import { db } from "../db";
import { parseByteRange } from "../services/byte-range";
import { pairedPhotoExtras } from "../services/photo-catalog";
import { originalFilePath } from "../services/photo-files";
import { developRaw, RawDevelopError } from "../services/raw-develop";

const router = new Hono();

// Experimental loupe rendering: no database writes, files, or HTTP cache.
router.get("/:id/developed", async (c) => {
	c.header("Cache-Control", "no-store");
	const id = Number(c.req.param("id"));
	if (!Number.isSafeInteger(id) || id <= 0)
		return c.json({ error: "Invalid photo ID" }, 400);
	try {
		const shown = await db.query.photos.findFirst({
			where: (photos, { eq }) => eq(photos.id, id),
			extras: pairedPhotoExtras,
		});
		if (!shown) return c.json({ error: "Photo not found" }, 404);
		const partnerId = shown.pairedPhotoId;
		const raw = shown.isRaw
			? shown
			: partnerId !== null
				? await db.query.photos.findFirst({
						where: (photos, { eq }) => eq(photos.id, partnerId),
					})
				: null;
		if (!raw?.isRaw) return c.json({ error: "Photo has no RAW source" }, 422);
		const path = originalFilePath(raw, config.PHOTO_DIRECTORY);
		if (!(await Bun.file(path).exists()))
			return c.json({ error: "RAW source file not found" }, 404);
		const jpeg = await developRaw(path, c.req.raw.signal);
		return new Response(new Uint8Array(jpeg), {
			headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
		});
	} catch (error) {
		if (error instanceof RawDevelopError)
			return c.json({ error: error.message }, error.status);
		if (c.req.raw.signal.aborted) return new Response(null, { status: 499 });
		console.error("Error developing RAW:", error);
		return c.json({ error: "Failed to develop RAW" }, 500);
	}
});

/**
 * `file` as a 200, or as the single byte range `rangeHeader` selects: 206 with
 * `Content-Range`, or 416 with `Content-Range: bytes *\/size`. Every response
 * advertises `Accept-Ranges: bytes` so players can seek. Hono answers HEAD
 * through this GET handler without a body.
 */
function fileResponse(
	file: BunFile,
	rangeHeader: string | undefined,
	headers: Record<string, string>,
): Response {
	const size = file.size;
	const range = parseByteRange(rangeHeader, size);
	const common = { ...headers, "Accept-Ranges": "bytes" };
	if (range.kind === "unsatisfiable") {
		return new Response(null, {
			status: 416,
			headers: { ...common, "Content-Range": `bytes */${size}` },
		});
	}
	if (range.kind === "partial") {
		return new Response(file.slice(range.start, range.end + 1), {
			status: 206,
			headers: {
				...common,
				"Content-Range": `bytes ${range.start}-${range.end}/${size}`,
				"Content-Length": String(range.end - range.start + 1),
			},
		});
	}
	return new Response(file, {
		status: 200,
		headers: { ...common, "Content-Length": String(size) },
	});
}

// Serve the original file (videos and standard stills) or a RAW's large WebP
// by ID, with single-range support for video seeking.
// This remains a REST endpoint as tRPC is not ideal for file streaming
router.get("/:id/file", async (c) => {
	const id = Number.parseInt(c.req.param("id"), 10);

	if (Number.isNaN(id)) {
		return c.json({ error: "Invalid photo ID" }, 400);
	}

	try {
		// Get photo from database
		const photo = await db.query.photos.findFirst({
			where: (photos, { eq }) => eq(photos.id, id),
		});

		if (!photo) {
			return c.json({ error: "Photo not found in database" }, 404);
		}

		// For RAW files, serve the large thumbnail instead of the original
		// (browsers can't display RAW files directly)
		if (photo.isRaw) {
			// Check if conversion was successful
			if (photo.rawStatus !== "converted") {
				return c.json(
					{
						error: "RAW file not converted",
						rawStatus: photo.rawStatus,
						rawError: photo.rawError,
					},
					422,
				);
			}

			// Serve the large thumbnail as the "full" image
			const thumbnailPath = join(
				photo.thumbnailRoot ?? config.THUMBNAILS_DIRECTORY,
				getThumbnailPath(photo.thumbnailKey ?? photo.path, "large"),
			);

			const thumbnailFile = Bun.file(thumbnailPath);

			if (!(await thumbnailFile.exists())) {
				return c.json({ error: "Converted image not found" }, 404);
			}

			return fileResponse(thumbnailFile, c.req.header("Range"), {
				"Content-Type": "image/webp",
				"Cache-Control": "public, max-age=3600",
				"X-Original-Format": photo.rawFormat || "RAW",
			});
		}

		// Standard image or video: serve the original file
		const file = Bun.file(originalFilePath(photo, config.PHOTO_DIRECTORY));
		if (!(await file.exists())) {
			return c.json({ error: "Image file not found" }, 404);
		}
		return fileResponse(file, c.req.header("Range"), {
			"Content-Type": photo.mimeType || "application/octet-stream",
			"Cache-Control": "public, max-age=3600",
		});
	} catch (error) {
		console.error("Error serving image:", error);
		return c.json({ error: "Failed to serve image" }, 500);
	}
});

// Serve thumbnail by ID and size
router.get("/:id/thumbnail/:size", async (c) => {
	const id = Number.parseInt(c.req.param("id"), 10);
	const size = c.req.param("size") as ThumbnailSize;

	if (Number.isNaN(id)) {
		return c.json({ error: "Invalid photo ID" }, 400);
	}

	// Validate thumbnail size
	if (!THUMBNAIL_CONFIG.sizes[size]) {
		return c.json(
			{
				error: `Invalid thumbnail size. Must be one of: ${Object.keys(THUMBNAIL_CONFIG.sizes).join(", ")}`,
			},
			400,
		);
	}

	try {
		// Check if photo exists in database
		const photo = await db.query.photos.findFirst({
			where: (photos, { eq }) => eq(photos.id, id),
		});

		if (!photo) {
			return c.json({ error: "Photo not found in database" }, 404);
		}

		// Resolve the committed generation; unadopted legacy rows retain their old path.
		const thumbnailPath = join(
			photo.thumbnailRoot ?? config.THUMBNAILS_DIRECTORY,
			getThumbnailPath(photo.thumbnailKey ?? photo.path, size),
		);

		// Read the thumbnail file
		const file = Bun.file(thumbnailPath);

		// Check if thumbnail exists, fallback to full image if not
		if (!(await file.exists())) {
			console.warn(
				`Thumbnail not found: ${thumbnailPath}, falling back to full image`,
			);
			// Redirect to full image endpoint
			return c.redirect(`/api/photos/${id}/file`);
		}

		// Generation identity prevents same-size/same-timestamp outputs sharing an ETag.
		const mtime = file.lastModified;
		const etag = `"${encodeURIComponent(photo.thumbnailKey ?? photo.path)}-${mtime}-${file.size}"`;

		// Check conditional request — return 304 if thumbnail hasn't changed
		const ifNoneMatch = c.req.header("if-none-match");
		if (ifNoneMatch === etag) {
			return new Response(null, { status: 304 });
		}

		// Stream the thumbnail
		const stream = file.stream();

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "image/webp",
				"Cache-Control": "public, max-age=31536000, immutable",
				"Content-Length": file.size.toString(),
				ETag: etag,
				"Last-Modified": new Date(mtime).toUTCString(),
			},
		});
	} catch (error) {
		console.error("Error serving thumbnail:", error);
		return c.json({ error: "Failed to serve thumbnail" }, 500);
	}
});

export default router;
