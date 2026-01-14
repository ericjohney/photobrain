import path from "node:path";
import { generateClipEmbedding as generateClipEmbeddingRust } from "@photobrain/image-processing";
import { getThumbnailPath } from "@photobrain/utils";
import { db, photos, photoEmbedding } from "@/db";
import { eq } from "drizzle-orm";

/**
 * Generate CLIP embedding for a single photo
 */
export async function generateClipEmbedding(
	photoId: number,
	thumbnailsDir: string,
): Promise<Float32Array | null> {
	// Get photo path from database
	const photo = await db
		.select({ path: photos.path })
		.from(photos)
		.where(eq(photos.id, photoId))
		.get();

	if (!photo) {
		throw new Error(`Photo ${photoId} not found`);
	}

	// Use the large thumbnail for embedding generation
	const thumbnailPath = path.join(
		thumbnailsDir,
		getThumbnailPath(photo.path, "large"),
	);

	try {
		const embedding = generateClipEmbeddingRust(thumbnailPath);
		if (embedding) {
			return new Float32Array(embedding);
		}
		return null;
	} catch (error) {
		console.error(
			`Failed to generate embedding for photo ${photoId}:`,
			error,
		);
		return null;
	}
}

/**
 * Save embedding to database
 */
export async function saveEmbeddingToDb(
	photoId: number,
	embedding: Float32Array | null,
): Promise<void> {
	if (embedding) {
		// Delete existing embedding if any
		await db
			.delete(photoEmbedding)
			.where(eq(photoEmbedding.photoId, photoId));

		// Insert new embedding into sidecar table
		await db.insert(photoEmbedding).values({
			photoId,
			embedding: Buffer.from(embedding.buffer),
			modelVersion: "clip-vit-b32",
			createdAt: new Date(),
		});

		// Update status on photos table
		await db
			.update(photos)
			.set({ embeddingStatus: "completed" })
			.where(eq(photos.id, photoId));
	} else {
		// Mark as failed
		await db
			.update(photos)
			.set({ embeddingStatus: "failed" })
			.where(eq(photos.id, photoId));
	}
}
