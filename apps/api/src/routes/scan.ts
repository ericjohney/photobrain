import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { photos, photoHashes, photoEmbeddings, photoThumbnails } from "@/db/schema";
import { scanDirectory, processPhotoAnalytics } from "@/scanner";
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

		// Insert photos and process analytics
		let inserted = 0;
		let skipped = 0;
		let analyticsProcessed = 0;

		for (const photo of result.photos) {
			try {
				// Check if photo already exists
				const existing = await db.query.photos.findFirst({
					where: eq(photos.path, photo.path),
				});

				if (existing) {
					skipped++;
				} else {
					// Insert basic photo metadata
					const insertResult = await db.insert(photos).values({
						path: photo.path,
						name: photo.name,
						size: photo.size,
						createdAt: photo.createdAt,
						modifiedAt: photo.modifiedAt,
						mimeType: photo.mimeType,
						width: photo.width,
						height: photo.height,
					}).returning({ id: photos.id });

					const photoId = insertResult[0].id;
					inserted++;

					// Process analytics (single image load for pHash, CLIP, thumbnails)
					try {
						const absolutePath = join(config.PHOTO_DIRECTORY, photo.path);
						const analytics = processPhotoAnalytics(
							absolutePath,
							config.THUMBNAIL_DIRECTORY,
							photoId,
						);

						const now = new Date();

						// Insert into separate tables
						await Promise.all([
							// Insert pHash
							db.insert(photoHashes).values({
								photoId,
								phash: analytics.phash,
								createdAt: now,
							}),
							// Insert CLIP embedding
							db.insert(photoEmbeddings).values({
								photoId,
								clipEmbedding: analytics.clipEmbedding,
								createdAt: now,
							}),
							// Insert thumbnails
							db.insert(photoThumbnails).values({
								photoId,
								tiny: analytics.thumbnails.tiny,
								small: analytics.thumbnails.small,
								medium: analytics.thumbnails.medium,
								large: analytics.thumbnails.large,
								createdAt: now,
							}),
						]);

						analyticsProcessed++;
					} catch (analyticsError) {
						console.error(`Error processing analytics for ${photo.path}:`, analyticsError);
						// Continue processing other photos even if analytics fails
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
			analyticsProcessed,
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
