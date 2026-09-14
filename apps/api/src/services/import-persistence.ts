import type { PhotoProcessingResult } from "@photobrain/image-processing";
import { eq } from "drizzle-orm";
import type { db } from "../db";
import { photoEmbedding, photoExif, photoPhash, photos } from "../db/schema";

export function saveScanBatch(
	database: typeof db,
	results: readonly PhotoProcessingResult[],
): number[] {
	// Bun SQLite transactions must stay synchronous. Native processing belongs outside.
	return database.transaction((tx) => {
		const ids: number[] = [];
		const now = new Date();
		for (const result of results) {
			if (!result.success) continue;
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
			};
			const { id } = tx
				.insert(photos)
				.values({
					...values,
					path: result.path,
					createdAt: new Date(result.createdAt),
				})
				.onConflictDoUpdate({ target: photos.path, set: values })
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

export function saveEmbeddingBatch(
	database: typeof db,
	photoIds: readonly number[],
	embeddings: readonly (number[] | null | undefined)[],
): { processed: number; successful: number } {
	return database.transaction((tx) => {
		let successful = 0;
		const now = new Date();
		for (let index = 0; index < photoIds.length; index++) {
			const photoId = photoIds[index];
			const embedding = embeddings[index];
			if (embedding) {
				const values = {
					embedding: Buffer.from(new Float32Array(embedding).buffer),
					modelVersion: "clip-vit-b32",
					createdAt: now,
				};
				tx.insert(photoEmbedding)
					.values({ photoId, ...values })
					.onConflictDoUpdate({ target: photoEmbedding.photoId, set: values })
					.run();
				successful++;
			}
			tx.update(photos)
				.set({ embeddingStatus: embedding ? "completed" : "failed" })
				.where(eq(photos.id, photoId))
				.run();
		}
		return { processed: photoIds.length, successful };
	});
}
