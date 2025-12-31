import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { photos } from "@/db/schema";
import { scanDirectory, generateThumbnailsForPhoto } from "@/scanner";
import { config } from "@/config";
import { join } from "node:path";

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
		let thumbnailsGenerated = 0;

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
					const insertResult = await db.insert(photos).values({
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
					}).returning({ id: photos.id });

					const photoId = insertResult[0].id;
					inserted++;

					// Generate thumbnails for the newly inserted photo
					try {
						const absolutePath = join(config.PHOTO_DIRECTORY, photo.path);
						const thumbnailPaths = generateThumbnailsForPhoto(
							absolutePath,
							config.THUMBNAIL_DIRECTORY,
							photoId,
						);

						// Update photo with thumbnail paths
						await db.update(photos)
							.set({
								thumbnailTiny: thumbnailPaths.thumbnailTiny,
								thumbnailSmall: thumbnailPaths.thumbnailSmall,
								thumbnailMedium: thumbnailPaths.thumbnailMedium,
								thumbnailLarge: thumbnailPaths.thumbnailLarge,
							})
							.where(eq(photos.id, photoId));

						thumbnailsGenerated++;
					} catch (thumbnailError) {
						console.error(`Error generating thumbnails for ${photo.path}:`, thumbnailError);
						// Continue processing other photos even if thumbnail generation fails
					}
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
			thumbnailsGenerated,
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
