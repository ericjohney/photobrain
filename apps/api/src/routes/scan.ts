import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/db";
import { photos, photoExif } from "@/db/schema";
import { scanDirectory } from "@/scanner";
import { config } from "@/config";
import { getAllThumbnailSizes } from "@photobrain/utils";
import { generateThumbnailsFromFile } from "@photobrain/image-processing";

const router = new Hono();

// Scan directory and populate database
router.post("/", async (c) => {
	try {
		const startTime = Date.now();

		// Create thumbnail directories if they don't exist
		const thumbnailSizes = getAllThumbnailSizes();
		for (const size of thumbnailSizes) {
			const sizePath = join(config.THUMBNAILS_DIRECTORY, size);
			await mkdir(sizePath, { recursive: true });
		}

		// Scan the directory
		const result = await scanDirectory({
			directory: config.PHOTO_DIRECTORY,
			recursive: true,
		});

		// Insert or update photos in database
		let inserted = 0;
		let skipped = 0;
		let thumbnailsGenerated = 0;

		for (const photoData of result.photos) {
			try {
				// Check if photo already exists
				const existing = await db.query.photos.findFirst({
					where: eq(photos.path, photoData.photo.path),
				});

				if (existing) {
					skipped++;
				} else {
					// Insert new photo and get the ID
					const [insertedPhoto] = await db
						.insert(photos)
						.values({
							path: photoData.photo.path,
							name: photoData.photo.name,
							size: photoData.photo.size,
							createdAt: photoData.photo.createdAt,
							modifiedAt: photoData.photo.modifiedAt,
							mimeType: photoData.photo.mimeType,
							width: photoData.photo.width,
							height: photoData.photo.height,
							phash: photoData.photo.phash,
							clipEmbedding: photoData.photo.clipEmbedding,
						})
						.returning();

					inserted++;

					// Insert EXIF data if available
					if (photoData.exif && insertedPhoto) {
						await db.insert(photoExif).values({
							photoId: insertedPhoto.id,
							...photoData.exif,
						});
					}

					// Generate thumbnails for the newly inserted photo
					if (insertedPhoto) {
						try {
							const fullPath = join(
								config.PHOTO_DIRECTORY,
								photoData.photo.path,
							);
							generateThumbnailsFromFile(
								fullPath,
								insertedPhoto.id,
								config.THUMBNAILS_DIRECTORY,
							);
							thumbnailsGenerated++;
						} catch (thumbnailError) {
							console.error(
								`Failed to generate thumbnails for photo ${insertedPhoto.id}:`,
								thumbnailError,
							);
							// Continue processing even if thumbnail generation fails
						}
					}
				}
			} catch (error) {
				console.error(`Error processing photo ${photoData.photo.path}:`, error);
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
