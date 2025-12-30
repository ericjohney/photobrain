import { Hono } from "hono";
import { like } from "drizzle-orm";
import { db } from "../db";
import { photos as photosTable } from "../db/schema";
import { searchPhotosByText } from "../db/vector-search";

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

// Get all photos (with optional name search)
router.get("/", async (c) => {
	const query = c.req.query("q");

	try {
		let photosList;

		if (query) {
			// Search by name
			photosList = await db
				.select()
				.from(photosTable)
				.where(like(photosTable.name, `%${query}%`))
				.all();
		} else {
			// Get all photos
			photosList = await db.select().from(photosTable).all();
		}

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

// Get single photo by ID
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

export default router;
