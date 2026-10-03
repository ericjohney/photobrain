import path from "node:path";
import type { ImageQuality } from "@photobrain/image-processing";
import { getThumbnailPath } from "@photobrain/utils";
import { sql } from "drizzle-orm";
import { photoQuality } from "../db/schema";
import type { ApiDatabase } from "./photo-catalog";
import { QUALITY_VERSION } from "./processing-versions";

/** Photos read, measured, and written per backfill step. */
export const QUALITY_BACKFILL_BATCH_SIZE = 200;
/** Thumbnail size the quality thresholds are calibrated against. */
export const QUALITY_THUMBNAIL_SIZE = "medium";

export type QualityBackfillRow = {
	photoId: number;
	thumbnailKey: string;
	thumbnailRoot: string | null;
};

/** Measures index-aligned thumbnail paths; `null` for unreadable files. */
export type MeasureQuality = (
	paths: string[],
) => Promise<(ImageQuality | null)[]>;

/**
 * Photos needing a measurement: completed thumbnails with a committed key whose
 * quality row is missing, from another generation, or from another
 * QUALITY_VERSION. Keyset-paginated by photo ID.
 */
export function readQualityBackfillBatch(
	database: ApiDatabase,
	afterPhotoId: number,
	limit = QUALITY_BACKFILL_BATCH_SIZE,
): QualityBackfillRow[] {
	return database.all<QualityBackfillRow>(sql`
		SELECT p.id AS photoId, p.thumbnail_key AS thumbnailKey, p.thumbnail_root AS thumbnailRoot
		FROM photos p
		LEFT JOIN photo_quality q ON q.photo_id = p.id
		WHERE p.id > ${afterPhotoId}
			AND p.thumbnail_status = 'completed'
			AND p.thumbnail_key IS NOT NULL
			AND (
				q.photo_id IS NULL
				OR q.thumbnail_key != p.thumbnail_key
				OR q.quality_version != ${QUALITY_VERSION}
			)
		ORDER BY p.id
		LIMIT ${limit}
	`);
}

/**
 * Writes measurements in one transaction. Each row is re-checked against the
 * photo's current committed generation, so a thumbnail regenerated between
 * measurement and write is skipped (and picked up by the next backfill).
 * Failed measurements (`quality: null`) are not written.
 */
export function saveQualityBatch(
	database: ApiDatabase,
	rows: readonly {
		photoId: number;
		thumbnailKey: string;
		quality: ImageQuality | null;
	}[],
): number {
	return database.transaction((tx) => {
		let saved = 0;
		for (const { photoId, thumbnailKey, quality } of rows) {
			if (!quality) continue;
			const current = tx.get<{ id: number } | undefined>(sql`
				SELECT id FROM photos
				WHERE id = ${photoId}
					AND thumbnail_status = 'completed'
					AND thumbnail_key = ${thumbnailKey}
			`);
			if (!current) continue;
			const values = {
				sharpness: quality.sharpness,
				brightness: quality.brightness,
				thumbnailKey,
				qualityVersion: QUALITY_VERSION,
			};
			tx.insert(photoQuality)
				.values({ photoId, ...values })
				.onConflictDoUpdate({ target: photoQuality.photoId, set: values })
				.run();
			saved++;
		}
		return saved;
	});
}

/**
 * One backfill step: read up to `limit` eligible photos after the cursor,
 * measure their committed `medium` thumbnails, and persist the results in one
 * generation-fenced transaction.
 */
export async function analyzeQualityBatch(
	database: ApiDatabase,
	measure: MeasureQuality,
	thumbnailsDirectory: string,
	afterPhotoId: number,
	limit = QUALITY_BACKFILL_BATCH_SIZE,
): Promise<{ read: number; measured: number; cursor: number }> {
	const rows = readQualityBackfillBatch(database, afterPhotoId, limit);
	if (rows.length === 0) return { read: 0, measured: 0, cursor: afterPhotoId };
	const results = await measure(
		rows.map((row) =>
			path.join(
				row.thumbnailRoot ?? thumbnailsDirectory,
				getThumbnailPath(row.thumbnailKey, QUALITY_THUMBNAIL_SIZE),
			),
		),
	);
	if (results.length !== rows.length) {
		throw new Error(
			`Quality measurement returned ${results.length} results for ${rows.length} paths`,
		);
	}
	const measured = saveQualityBatch(
		database,
		rows.map((row, index) => ({
			photoId: row.photoId,
			thumbnailKey: row.thumbnailKey,
			quality: results[index],
		})),
	);
	return {
		read: rows.length,
		measured,
		cursor: rows[rows.length - 1].photoId,
	};
}
