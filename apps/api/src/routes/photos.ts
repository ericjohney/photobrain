import { Hono } from "hono";
import { join } from "node:path";
import { db } from "@/db";
import { photos as photosTable, photoThumbnails } from "@/db/schema";
import { searchPhotosByText } from "@/services/vector-search";
import { config } from "@/config";
import { eq } from "drizzle-orm";

const router = new Hono();

// Semantic search using CLIP embeddings
router.get("/search", async (c) => {
	const query = c.req.query("q");
	const limit = Number.parseInt(c.req.query("limit") || "20", 10);

	if (!query) {
		return c.json({ error: "Search query required" }, 400);
	}

	try {
		// Search photos using semantic similarity
		const photos = await searchPhotosByText(query, limit);

		return c.json({
			photos,
			total: photos.length,
			query,
		});
	} catch (error) {
		console.error("Error performing semantic search:", error);
		return c.json(
			{
				error: "Failed to perform semantic search",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			500,
		);
	}
});

// Get all photos
router.get("/", async (c) => {
	try {
		const photosList = await db.select().from(photosTable).all();

		return c.json({
			photos: photosList,
			total: photosList.length,
		});
	} catch (error) {
		console.error("Error fetching photos:", error);
		return c.json(
			{
				error: "Failed to fetch photos",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			500,
		);
	}
});

// Get single photo metadata by ID
router.get("/:id", async (c) => {
	const id = Number.parseInt(c.req.param("id"), 10);

	if (Number.isNaN(id)) {
		return c.json({ error: "Invalid photo ID" }, 400);
	}

	try {
		const photo = await db.query.photos.findFirst({
			where: (photos, { eq }) => eq(photos.id, id),
		});

		if (!photo) {
			return c.json({ error: "Photo not found" }, 404);
		}

		return c.json(photo);
	} catch (error) {
		console.error("Error fetching photo:", error);
		return c.json(
			{
				error: "Failed to fetch photo",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			500,
		);
	}
});

// Serve thumbnail by ID and size
router.get("/:id/thumbnail/:size", async (c) => {
	const id = Number.parseInt(c.req.param("id"), 10);
	const size = c.req.param("size");

	if (Number.isNaN(id)) {
		return c.json({ error: "Invalid photo ID" }, 400);
	}

	// Validate size parameter
	const validSizes = ["tiny", "small", "medium", "large"];
	if (!validSizes.includes(size)) {
		return c.json({ error: `Invalid size. Must be one of: ${validSizes.join(", ")}` }, 400);
	}

	try {
		// Get thumbnail paths from photo_thumbnails table
		const thumbnail = await db.query.photoThumbnails.findFirst({
			where: (thumbnails, { eq }) => eq(thumbnails.photoId, id),
		});

		if (!thumbnail) {
			return c.json({ error: "Thumbnails not generated yet" }, 404);
		}

		// Get the appropriate thumbnail path based on size
		const thumbnailPath =
			size === "tiny"
				? thumbnail.tiny
				: size === "small"
					? thumbnail.small
					: size === "medium"
						? thumbnail.medium
						: thumbnail.large;

		// Resolve thumbnail path
		const absolutePath = join(config.THUMBNAIL_DIRECTORY, thumbnailPath);

		// Read the file using Bun.file
		const file = Bun.file(absolutePath);

		// Check if file exists
		if (!(await file.exists())) {
			return c.json({ error: "Thumbnail file not found" }, 404);
		}

		// Stream the file
		const stream = file.stream();

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "image/jpeg",
				"Cache-Control": "public, max-age=31536000", // Cache for 1 year
				"Content-Length": file.size.toString(),
			},
		});
	} catch (error) {
		console.error("Error serving thumbnail:", error);
		return c.json({ error: "Failed to serve thumbnail" }, 500);
	}
});

// Serve actual image file by ID
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

export default router;
