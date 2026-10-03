import type { PhotoProcessingResult } from "@photobrain/image-processing";
import { eq, sql } from "drizzle-orm";
import type { db } from "../db";
import { photoEmbedding, photoExif, photoPhash, photos } from "../db/schema";
import {
	replacePhotoTags,
	type ScoredTag,
	scoreTags,
	type TagLabelMatrix,
} from "./photo-tagging";
import { EMBEDDING_MODEL_VERSION } from "./processing-versions";
import { TAG_VOCABULARY_VERSION } from "./tag-vocabulary";

export type ProcessedMediaState = {
	sourceRoot: string;
	sourceFingerprint: string;
	mediaVersion: string;
	thumbnailKey: string;
	thumbnailRoot: string;
	thumbnailFingerprint: string;
};

export type EmbeddingTarget = { id: number; thumbnailKey: string | null };

export function saveScanBatch(
	database: typeof db,
	results: readonly PhotoProcessingResult[],
	mediaStates?: ReadonlyMap<string, ProcessedMediaState>,
): number[] {
	// Bun SQLite transactions must stay synchronous. Native processing belongs outside.
	return database.transaction((tx) => {
		const ids: number[] = [];
		const now = new Date();
		// SQLite stores seconds; advance the public cache token even when two
		// generations commit within one second or the wall clock moves backwards.
		const nextThumbnailUpdatedAt = sql`max(
			coalesce(${photos.thumbnailUpdatedAt} + 1, excluded.thumbnail_updated_at),
			excluded.thumbnail_updated_at
		)`;
		for (const result of results) {
			if (!result.success) continue;
			const mediaState = mediaStates?.get(result.path);
			const values = {
				name: result.name,
				size: result.size,
				modifiedAt: new Date(result.modifiedAt),
				width: result.width ?? null,
				height: result.height ?? null,
				mimeType: result.mimeType ?? null,
				isRaw: result.isRaw,
				rawFormat: result.rawFormat ?? null,
				rawStatus: result.rawStatus ?? null,
				rawError: result.rawError ?? null,
				thumbnailStatus: "completed",
				thumbnailUpdatedAt: now,
				embeddingStatus: "pending",
				phashStatus: result.phash ? "completed" : "failed",
				sourceRoot: mediaState?.sourceRoot ?? null,
				sourceFingerprint: mediaState?.sourceFingerprint ?? null,
				mediaVersion: mediaState?.mediaVersion ?? null,
				thumbnailKey: mediaState?.thumbnailKey ?? null,
				thumbnailRoot: mediaState?.thumbnailRoot ?? null,
				thumbnailFingerprint: mediaState?.thumbnailFingerprint ?? null,
			};
			const { id } = tx
				.insert(photos)
				.values({
					...values,
					path: result.path,
					createdAt: new Date(result.createdAt),
				})
				.onConflictDoUpdate({
					target: photos.path,
					set: { ...values, thumbnailUpdatedAt: nextThumbnailUpdatedAt },
				})
				.returning({ id: photos.id })
				.get();

			if (result.exif) {
				const exif = result.exif;
				const values = {
					cameraMake: exif.cameraMake ?? null,
					cameraModel: exif.cameraModel ?? null,
					lensMake: exif.lensMake ?? null,
					lensModel: exif.lensModel ?? null,
					focalLength: exif.focalLength ?? null,
					iso: exif.iso ?? null,
					aperture: exif.aperture ?? null,
					shutterSpeed: exif.shutterSpeed ?? null,
					exposureBias: exif.exposureBias ?? null,
					dateTaken: exif.dateTaken ?? null,
					gpsLatitude:
						exif.gpsLatitude !== undefined ? String(exif.gpsLatitude) : null,
					gpsLongitude:
						exif.gpsLongitude !== undefined ? String(exif.gpsLongitude) : null,
					gpsAltitude:
						exif.gpsAltitude !== undefined ? String(exif.gpsAltitude) : null,
				};
				tx.insert(photoExif)
					.values({ photoId: id, ...values })
					.onConflictDoUpdate({ target: photoExif.photoId, set: values })
					.run();
			}
			if (result.phash) {
				const values = {
					hash: result.phash,
					algorithm: "double_gradient_8x8",
					createdAt: now,
				};
				tx.insert(photoPhash)
					.values({ photoId: id, ...values })
					.onConflictDoUpdate({ target: photoPhash.photoId, set: values })
					.run();
			}
			ids.push(id);
		}
		return ids;
	});
}

/**
 * Saves CLIP vectors and statuses for current-generation targets. With
 * `labels`, each saved vector's tags are scored before the transaction and
 * replaced inside it with `tags_version` set; without labels the photo's old
 * tags are cleared and `tags_version` is null so the tag backfill retags it.
 * Stale and failed results leave vectors and tags untouched.
 */
export function saveEmbeddingBatch(
	database: typeof db,
	targets: readonly EmbeddingTarget[],
	embeddings: readonly (number[] | null | undefined)[],
	labels?: TagLabelMatrix | null,
): { processed: number; successful: number } {
	// Scoring is pure JS and stays outside the synchronous transaction.
	const scored: (ScoredTag[] | null)[] = embeddings.map((embedding) =>
		embedding && labels ? scoreTags(embedding, labels) : null,
	);
	return database.transaction((tx) => {
		let successful = 0;
		const now = new Date();
		for (let index = 0; index < targets.length; index++) {
			const { id: photoId, thumbnailKey } = targets[index];
			const current = tx
				.select({ thumbnailKey: photos.thumbnailKey })
				.from(photos)
				.where(eq(photos.id, photoId))
				.get();
			// Read and write in the same transaction: stale successes and failures
			// must both leave the current generation untouched.
			if (!current || current.thumbnailKey !== thumbnailKey) continue;
			const embedding = embeddings[index];
			if (embedding) {
				const tags = scored[index];
				const values = {
					embedding: Buffer.from(new Float32Array(embedding).buffer),
					modelVersion: EMBEDDING_MODEL_VERSION,
					thumbnailKey,
					tagsVersion: tags ? TAG_VOCABULARY_VERSION : null,
					createdAt: now,
				};
				tx.insert(photoEmbedding)
					.values({ photoId, ...values })
					.onConflictDoUpdate({ target: photoEmbedding.photoId, set: values })
					.run();
				replacePhotoTags(tx, photoId, tags ?? []);
				successful++;
			}
			tx.update(photos)
				.set({ embeddingStatus: embedding ? "completed" : "failed" })
				.where(eq(photos.id, photoId))
				.run();
		}
		return { processed: targets.length, successful };
	});
}
