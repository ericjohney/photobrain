import path from "node:path";
import { generatePhash as generatePhashRust } from "@photobrain/image-processing";
import { getThumbnailPath } from "@photobrain/utils";
import { eq } from "drizzle-orm";
import { db, photoPhash, photos } from "@/db";

/**
 * Generate perceptual hash for a single photo
 */
export async function generatePhash(
	photoId: number,
	thumbnailsDir: string,
): Promise<string | null> {
	// Get photo path from database
	const photo = await db
		.select({ path: photos.path })
		.from(photos)
		.where(eq(photos.id, photoId))
		.get();

	if (!photo) {
		throw new Error(`Photo ${photoId} not found`);
	}

	// Use the large thumbnail for phash generation
	const thumbnailPath = path.join(
		thumbnailsDir,
		getThumbnailPath(photo.path, "large"),
	);

	try {
		// generatePhash throws on error, returns string on success
		const hash = generatePhashRust(thumbnailPath);
		return hash;
	} catch (error) {
		console.error(`Failed to generate phash for photo ${photoId}:`, error);
		return null;
	}
}

/**
 * Save phash to database
 */
export async function savePhashToDb(
	photoId: number,
	hash: string | null,
): Promise<void> {
	if (hash) {
		// Delete existing phash if any
		await db.delete(photoPhash).where(eq(photoPhash.photoId, photoId));

		// Insert new phash into sidecar table
		await db.insert(photoPhash).values({
			photoId,
			hash,
			algorithm: "double_gradient_8x8",
			createdAt: new Date(),
		});

		// Update status on photos table
		await db
			.update(photos)
			.set({ phashStatus: "completed" })
			.where(eq(photos.id, photoId));
	} else {
		// Mark as failed
		await db
			.update(photos)
			.set({ phashStatus: "failed" })
			.where(eq(photos.id, photoId));
	}
}
