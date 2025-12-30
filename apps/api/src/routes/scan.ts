import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { photos } from "../db/schema";
import { scanDirectory } from "../scanner";
import { config } from "../config";

const router = new Hono();

// Scan directory and populate database
router.post("/", async (c) => {
	try {
		const startTime = Date.now();

		// Scan the directory
		const result = await scanDirectory({
			directory: config.PHOTO_DIRECTORY,
			recursive: true,
		});

		// Insert or update photos in database
		let inserted = 0;
		let skipped = 0;

		for (const photo of result.photos) {
			try {
				// Check if photo already exists
				const existing = await db.query.photos.findFirst({
					where: eq(photos.path, photo.path),
				});

				if (existing) {
					skipped++;
				} else {
					// Insert new photo
					await db.insert(photos).values({
						path: photo.path,
						name: photo.name,
						size: photo.size,
						createdAt: photo.createdAt,
						modifiedAt: photo.modifiedAt,
						mimeType: photo.mimeType,
						width: photo.width,
						height: photo.height,
						phash: photo.phash,
						clipEmbedding: photo.clipEmbedding,
					});
					inserted++;
				}
			} catch (error) {
				console.error(`Error processing photo ${photo.path}:`, error);
			}
		}

		const totalTime = Date.now() - startTime;

		return c.json({
			success: true,
			scanned: result.photos.length,
			inserted,
			skipped,
			duration: totalTime,
			scanDuration: result.duration,
			directory: config.PHOTO_DIRECTORY,
		});
	} catch (error) {
		console.error("Scan error:", error);
		return c.json(
			{
				success: false,
				error: "Failed to scan directory",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			500,
		);
	}
});

export default router;
