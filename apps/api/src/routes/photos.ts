import { Hono } from "hono";
import { join } from "node:path";
import { db } from "@/db";
import { config } from "@/config";
import { THUMBNAIL_CONFIG, type ThumbnailSize } from "@photobrain/utils";

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

		// Resolve relative path to absolute path
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
			{ error: `Invalid thumbnail size. Must be one of: ${Object.keys(THUMBNAIL_CONFIG.sizes).join(", ")}` },
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

		// Construct thumbnail path
		const thumbnailPath = join(
			config.THUMBNAILS_DIRECTORY,
			size,
			`${id}.webp`,
		);

		// Read the thumbnail file
		const file = Bun.file(thumbnailPath);

		// Check if thumbnail exists, fallback to full image if not
		if (!(await file.exists())) {
			console.warn(`Thumbnail not found: ${thumbnailPath}, falling back to full image`);
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
