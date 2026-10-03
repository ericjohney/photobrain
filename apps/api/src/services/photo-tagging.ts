import { eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type * as schema from "../db/schema";
import { photoEmbedding, photoTags } from "../db/schema";
import type { ApiDatabase } from "./photo-catalog";
import { EMBEDDING_MODEL_VERSION } from "./processing-versions";
import { TAG_VOCABULARY_VERSION } from "./tag-vocabulary";

/**
 * Minimum softmax probability for a label to become a tag. Calibrated against
 * real CLIP ViT-B/32 vectors; see "Automatic Tags" in apps/api/AGENTS.md.
 */
export const TAG_MIN_PROBABILITY = 0.15;
export const MAX_TAGS_PER_PHOTO = 3;
/** CLIP's learned logit scale (exp(4.6052) = 100). */
const LOGIT_SCALE = 100;
/** Rows read, scored, and written per backfill step. */
export const TAG_BACKFILL_BATCH_SIZE = 1_000;

/** The API database or one of its synchronous transactions. */
type Executor = BaseSQLiteDatabase<"sync", void, typeof schema>;

/** L2-normalized label vectors, row-major (`tags.length * dimension`). */
export type TagLabelMatrix = {
	tags: readonly string[];
	dimension: number;
	vectors: Float32Array;
};

export type ScoredTag = { tag: string; score: number };

/** Builds a label matrix, normalizing each vector so dot products are cosines. */
export function createTagLabelMatrix(
	labels: readonly { tag: string; vector: ArrayLike<number> }[],
): TagLabelMatrix {
	const dimension = labels[0]?.vector.length ?? 0;
	const vectors = new Float32Array(labels.length * dimension);
	labels.forEach(({ vector }, row) => {
		if (vector.length !== dimension) {
			throw new Error("Tag label vectors must share one dimension");
		}
		let norm = 0;
		for (let index = 0; index < dimension; index++) {
			norm += vector[index] * vector[index];
		}
		if (norm === 0) throw new Error("Tag label vector has zero length");
		const inverse = 1 / Math.sqrt(norm);
		for (let index = 0; index < dimension; index++) {
			vectors[row * dimension + index] = vector[index] * inverse;
		}
	});
	return { tags: labels.map(({ tag }) => tag), dimension, vectors };
}

/**
 * Zero-shot CLIP tags: softmax(100 * cosine) over all labels, keeping labels
 * with probability >= TAG_MIN_PROBABILITY, highest first (ties by tag), at most
 * three, with scores rounded to 4 decimal places. A vector of another dimension
 * or zero length yields no tags.
 */
export function scoreTags(
	image: ArrayLike<number>,
	labels: TagLabelMatrix,
): ScoredTag[] {
	const { dimension, vectors, tags } = labels;
	if (image.length !== dimension || tags.length === 0) return [];
	let norm = 0;
	for (let index = 0; index < dimension; index++) {
		norm += image[index] * image[index];
	}
	if (norm === 0) return [];
	const scale = LOGIT_SCALE / Math.sqrt(norm);
	const weights = new Float64Array(tags.length);
	let maxLogit = Number.NEGATIVE_INFINITY;
	for (let row = 0; row < tags.length; row++) {
		let dot = 0;
		const offset = row * dimension;
		for (let index = 0; index < dimension; index++) {
			dot += vectors[offset + index] * image[index];
		}
		weights[row] = dot * scale;
		if (weights[row] > maxLogit) maxLogit = weights[row];
	}
	let sum = 0;
	for (let row = 0; row < weights.length; row++) {
		weights[row] = Math.exp(weights[row] - maxLogit);
		sum += weights[row];
	}
	const selected: { tag: string; probability: number }[] = [];
	for (let row = 0; row < weights.length; row++) {
		const probability = weights[row] / sum;
		if (probability >= TAG_MIN_PROBABILITY) {
			selected.push({ tag: tags[row], probability });
		}
	}
	return selected
		.sort(
			(left, right) =>
				right.probability - left.probability ||
				(left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0),
		)
		.slice(0, MAX_TAGS_PER_PHOTO)
		.map(({ tag, probability }) => ({
			tag,
			score: Math.round(probability * 10_000) / 10_000,
		}));
}

/** Views a stored Float32 embedding BLOB, copying only when misaligned. */
function embeddingFromBlob(blob: Uint8Array): Float32Array {
	const length = Math.floor(blob.byteLength / 4);
	return blob.byteOffset % 4 === 0
		? new Float32Array(blob.buffer, blob.byteOffset, length)
		: new Float32Array(blob.slice(0, length * 4).buffer);
}

/**
 * Replaces a photo's tags. Must run inside the caller's transaction after its
 * generation check; the caller also records `tags_version` on the vector.
 */
export function replacePhotoTags(
	tx: Executor,
	photoId: number,
	tags: readonly ScoredTag[],
) {
	tx.delete(photoTags).where(eq(photoTags.photoId, photoId)).run();
	if (tags.length > 0) {
		tx.insert(photoTags)
			.values(tags.map(({ tag, score }) => ({ photoId, tag, score })))
			.run();
	}
}

type TagBackfillRow = {
	photoId: number;
	thumbnailKey: string | null;
	embedding: Uint8Array;
};

/**
 * Committed vectors needing (re)tagging: completed status, current model,
 * vector key matching the photo's committed thumbnail key, and tags missing or
 * from another vocabulary version. Keyset-paginated by photo ID.
 */
export function readTagBackfillBatch(
	database: ApiDatabase,
	afterPhotoId: number,
	limit = TAG_BACKFILL_BATCH_SIZE,
): TagBackfillRow[] {
	return database.all<TagBackfillRow>(sql`
		SELECT e.photo_id AS photoId, e.thumbnail_key AS thumbnailKey, e.embedding AS embedding
		FROM photo_embedding e
		INNER JOIN photos p ON p.id = e.photo_id
		WHERE e.photo_id > ${afterPhotoId}
			AND p.embedding_status = 'completed'
			AND e.model_version = ${EMBEDDING_MODEL_VERSION}
			AND e.thumbnail_key IS p.thumbnail_key
			AND (e.tags_version IS NULL OR e.tags_version != ${TAG_VOCABULARY_VERSION})
		ORDER BY e.photo_id
		LIMIT ${limit}
	`);
}

/**
 * Writes scored backfill tags in one transaction. Each row is re-checked: a
 * photo whose generation, vector key, status, or tag version changed since the
 * read is skipped, so a newer embedding save always wins.
 */
export function saveTagBatch(
	database: ApiDatabase,
	rows: readonly {
		photoId: number;
		thumbnailKey: string | null;
		tags: readonly ScoredTag[];
	}[],
): number {
	return database.transaction((tx) => {
		let saved = 0;
		for (const { photoId, thumbnailKey, tags } of rows) {
			const eligible = tx.get<{ photoId: number } | undefined>(sql`
				SELECT e.photo_id AS photoId
				FROM photo_embedding e
				INNER JOIN photos p ON p.id = e.photo_id
				WHERE e.photo_id = ${photoId}
					AND p.embedding_status = 'completed'
					AND e.model_version = ${EMBEDDING_MODEL_VERSION}
					AND e.thumbnail_key IS ${thumbnailKey}
					AND p.thumbnail_key IS ${thumbnailKey}
					AND (e.tags_version IS NULL OR e.tags_version != ${TAG_VOCABULARY_VERSION})
			`);
			if (!eligible) continue;
			replacePhotoTags(tx, photoId, tags);
			tx.update(photoEmbedding)
				.set({ tagsVersion: TAG_VOCABULARY_VERSION })
				.where(eq(photoEmbedding.photoId, photoId))
				.run();
			saved++;
		}
		return saved;
	});
}

/**
 * One backfill step: read up to `limit` eligible vectors after the cursor,
 * score them in JS, and persist them in a single fenced transaction.
 */
export function tagPhotoBatch(
	database: ApiDatabase,
	labels: TagLabelMatrix,
	afterPhotoId: number,
	limit = TAG_BACKFILL_BATCH_SIZE,
): { read: number; tagged: number; cursor: number } {
	const rows = readTagBackfillBatch(database, afterPhotoId, limit);
	if (rows.length === 0) return { read: 0, tagged: 0, cursor: afterPhotoId };
	const tagged = saveTagBatch(
		database,
		rows.map(({ photoId, thumbnailKey, embedding }) => ({
			photoId,
			thumbnailKey,
			tags: scoreTags(embeddingFromBlob(embedding), labels),
		})),
	);
	return { read: rows.length, tagged, cursor: rows[rows.length - 1].photoId };
}

/**
 * A photo's tags, highest score first (ties by tag), in one statement.
 * @returns `null` when the photo does not exist.
 */
export function getPhotoTags(
	database: ApiDatabase,
	photoId: number,
): { tags: ScoredTag[] } | null {
	const rows = database.all<{ tag: string | null; score: number | null }>(sql`
		SELECT t.tag AS tag, t.score AS score
		FROM photos p
		LEFT JOIN photo_tags t ON t.photo_id = p.id
		WHERE p.id = ${photoId}
		ORDER BY t.score DESC, t.tag ASC
	`);
	if (rows.length === 0) return null;
	return {
		tags: rows.flatMap(({ tag, score }) =>
			tag === null || score === null ? [] : [{ tag, score }],
		),
	};
}
