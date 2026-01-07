import { join } from "node:path";
import { THUMBNAIL_CONFIG, type ThumbnailSize } from "@photobrain/utils";
import { Hono } from "hono";
import { config } from "@/config";
import { db } from "@/db";

const router = new Hono();

// Serve actual image file by ID
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
			const pathWithoutExt = photo.path.replace(/\.[^/.]+$/, "");
			const thumbnailPath = join(
				config.THUMBNAILS_DIRECTORY,
				"large",
				`${pathWithoutExt}.webp`,
			);

			const thumbnailFile = Bun.file(thumbnailPath);

			if (!(await thumbnailFile.exists())) {
				return c.json({ error: "Converted image not found" }, 404);
			}

			return new Response(thumbnailFile.stream(), {
				status: 200,
				headers: {
					"Content-Type": "image/webp",
					"Cache-Control": "public, max-age=3600",
					"Content-Length": thumbnailFile.size.toString(),
					"X-Original-Format": photo.rawFormat || "RAW",
				},
			});
		}

		// Standard image: serve the original file
		const absolutePath = join(config.PHOTO_DIRECTORY, photo.path);

		// Read the file using Bun.file
		const file = Bun.file(absolutePath);

		// Check if file exists
		if (!(await file.exists())) {
			return c.json({ error: "Image file not found" }, 404);
		}

		// Stream the file
		const stream = file.stream();

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": photo.mimeType || "application/octet-stream",
				"Cache-Control": "public, max-age=3600",
				"Content-Length": file.size.toString(),
			},
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

		// Construct thumbnail path using photo's relative path
		// Thumbnails mirror the directory structure: thumbnails/{size}/{path}.webp
		const pathWithoutExt = photo.path.replace(/\.[^/.]+$/, "");
		const thumbnailPath = join(
			config.THUMBNAILS_DIRECTORY,
			size,
			`${pathWithoutExt}.webp`,
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

		// Stream the thumbnail
		const stream = file.stream();

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "image/webp",
				// Aggressive caching for thumbnails (1 year) since they're immutable
				"Cache-Control": "public, max-age=31536000, immutable",
				"Content-Length": file.size.toString(),
			},
		});
	} catch (error) {
		console.error("Error serving thumbnail:", error);
		return c.json({ error: "Failed to serve thumbnail" }, 500);
	}
});

export default router;
