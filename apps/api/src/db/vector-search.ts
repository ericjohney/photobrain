import { sql, inArray } from "drizzle-orm";
import { db } from "./index";
import { photos as photosTable } from "./schema";
import type { Photo } from "./schema";

/**
 * Find similar photos using CLIP embedding vector similarity
 * @param embedding - The query embedding (Float32Array or number array)
 * @param limit - Maximum number of results to return
 * @returns Array of photos sorted by similarity
 */
export async function findSimilarPhotos(
	embedding: Float32Array | number[],
	limit = 10,
): Promise<Photo[]> {
	const embeddingBlob =
		embedding instanceof Float32Array
			? Buffer.from(embedding.buffer)
			: Buffer.from(new Float32Array(embedding).buffer);

	const results = await db.all<{ id: number; distance: number }>(
		sql`
      SELECT
        id,
        vec_distance_L2(clip_embedding, ${embeddingBlob}) as distance
      FROM photos
      WHERE clip_embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT ${limit}
    `,
	);

	// Fetch full photo details
	const photoIds = results.map((r) => r.id);
	const photosList =
		photoIds.length > 0
			? await db
					.select()
					.from(photosTable)
					.where(inArray(photosTable.id, photoIds))
					.all()
			: [];

	// Sort photos by similarity distance
	const photosMap = new Map(photosList.map((p) => [p.id, p]));
	const sortedPhotos = results
		.map((r) => photosMap.get(r.id))
		.filter((p): p is Photo => p !== undefined);

	return sortedPhotos;
}

/**
 * Search photos using text query via CLIP embeddings
 * @param text - The search query text
 * @param limit - Maximum number of results to return
 * @returns Array of photos sorted by semantic similarity
 */
export async function searchPhotosByText(
	text: string,
	limit = 20,
): Promise<Photo[]> {
	const { clipTextEmbedding } = await import("@photobrain/image-processing");
	const textEmbedding = clipTextEmbedding(text);
	return findSimilarPhotos(textEmbedding, limit);
}
