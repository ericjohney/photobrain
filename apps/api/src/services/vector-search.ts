import { clipTextEmbedding } from "@photobrain/image-processing";
import { inArray, sql } from "drizzle-orm";
import {
	type PublicPhotoWithExif,
	photos as photosTable,
	publicPhotoColumns,
} from "../db/schema";
import type { ApiDatabase } from "./photo-catalog";
import { EMBEDDING_MODEL_VERSION } from "./processing-versions";

/**
 * Loads public photo rows with EXIF for ranked IDs in one query, preserving rank order.
 * IDs whose rows disappeared between ranking and hydration are dropped.
 */
async function hydrateRankedPhotos(
	database: ApiDatabase,
	rankedIds: readonly number[],
): Promise<PublicPhotoWithExif[]> {
	if (rankedIds.length === 0) return [];
	const rows = await database.query.photos.findMany({
		columns: publicPhotoColumns,
		where: inArray(photosTable.id, [...rankedIds]),
		with: { exif: true },
	});
	const byId = new Map(rows.map((photo) => [photo.id, photo]));
	return rankedIds.flatMap((id) => {
		const photo = byId.get(id);
		return photo ? [photo] : [];
	});
}

/**
 * Find photos nearest to a query embedding using the photo_embedding sidecar table.
 * Only completed vectors for the current model and committed thumbnail generation qualify.
 */
export async function findSimilarPhotos(
	database: ApiDatabase,
	embedding: Float32Array | number[],
	limit = 10,
) {
	const embeddingBlob =
		embedding instanceof Float32Array
			? Buffer.from(embedding.buffer)
			: Buffer.from(new Float32Array(embedding).buffer);

	const results = await database.all<{ photo_id: number; distance: number }>(
		sql`
      SELECT
        e.photo_id,
        vec_distance_L2(e.embedding, ${embeddingBlob}) as distance
      FROM photo_embedding e
      INNER JOIN photos p ON p.id = e.photo_id
      WHERE p.embedding_status = 'completed'
        AND e.thumbnail_key IS p.thumbnail_key
        AND e.model_version = ${EMBEDDING_MODEL_VERSION}
      ORDER BY distance ASC
      LIMIT ${limit}
    `,
	);

	return hydrateRankedPhotos(
		database,
		results.map((result) => result.photo_id),
	);
}

/**
 * Search photos using a CLIP text embedding of the query.
 */
export async function searchPhotosByText(
	database: ApiDatabase,
	text: string,
	limit = 20,
) {
	return findSimilarPhotos(database, clipTextEmbedding(text), limit);
}

export type SimilarPhotosResult = {
	photos: PublicPhotoWithExif[];
	total: number;
	sourcePhotoId: number;
	indexed: boolean;
};

type SimilarRow = {
	source_id: number;
	indexed: number;
	photo_id: number | null;
};

/**
 * Rank photos by CLIP vector distance to an existing photo's committed vector.
 *
 * One statement resolves the source vector, applies the text-search validity
 * filters to candidates, excludes the source, and orders by distance then ID.
 * The source row is always returned (left-joined to neighbours) so existence
 * and indexing state need no extra round trip.
 *
 * @returns `null` when the photo does not exist; `indexed: false` when it has no
 * usable vector.
 */
export async function findSimilarToPhoto(
	database: ApiDatabase,
	photoId: number,
	limit: number,
): Promise<SimilarPhotosResult | null> {
	const rows = await database.all<SimilarRow>(
		sql`
      WITH source AS (
        SELECT
          p.id AS id,
          CASE
            WHEN p.embedding_status = 'completed'
              AND e.model_version = ${EMBEDDING_MODEL_VERSION}
              AND e.thumbnail_key IS p.thumbnail_key
            THEN e.embedding
          END AS embedding
        FROM photos p
        LEFT JOIN photo_embedding e ON e.photo_id = p.id
        WHERE p.id = ${photoId}
      ),
      neighbours AS (
        SELECT
          e.photo_id AS photo_id,
          vec_distance_L2(e.embedding, s.embedding) AS distance
        FROM source s
        INNER JOIN photo_embedding e
          ON e.photo_id != s.id
          AND length(e.embedding) = length(s.embedding)
        INNER JOIN photos p ON p.id = e.photo_id
        WHERE s.embedding IS NOT NULL
          AND p.embedding_status = 'completed'
          AND e.thumbnail_key IS p.thumbnail_key
          AND e.model_version = ${EMBEDDING_MODEL_VERSION}
        ORDER BY distance ASC, e.photo_id ASC
        LIMIT ${limit}
      )
      SELECT
        s.id AS source_id,
        s.embedding IS NOT NULL AS indexed,
        n.photo_id AS photo_id
      FROM source s
      LEFT JOIN neighbours n ON 1
      ORDER BY n.distance ASC, n.photo_id ASC
    `,
	);

	const source = rows[0];
	if (!source) return null;
	const rankedIds = rows.flatMap((row) =>
		row.photo_id === null ? [] : [row.photo_id],
	);
	const photos = await hydrateRankedPhotos(database, rankedIds);
	return {
		photos,
		total: photos.length,
		sourcePhotoId: source.source_id,
		indexed: source.indexed === 1,
	};
}
