import { stat } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, isNull, notExists, or } from "drizzle-orm";
import type { db } from "../db";
import {
	collectionPhotos,
	eventPhotos,
	photoEmbedding,
	photoExif,
	photoFaceScan,
	photoFaces,
	photoPhash,
	photoPlaces,
	photoQuality,
	photos,
	photoTags,
	scanItems,
	scanManifests,
} from "../db/schema";

type LibraryDatabase = typeof db;

/** Sources checked concurrently, and rows deleted per statement. */
const STAT_CONCURRENCY = 16;
const DELETE_CHUNK = 500;

export type RemovedPhotos = {
	/** Catalog rows whose source file is gone and were deleted. */
	removed: number;
	/** Undiscovered rows whose source still exists (hidden, unsupported, or unreadable). */
	retained: number;
	/** Set when reconciliation refused to delete anything. */
	skipped?: "no-manifest" | "empty-discovery" | "mass-removal";
};

/**
 * Without `allowMassRemoval`, refuse when more than this fraction of the
 * root's catalog (and more than `MASS_REMOVAL_MIN` rows) would go at once: an
 * unmounted share inside the library looks exactly like deleted files.
 */
export const MASS_REMOVAL_FRACTION = 0.5;
export const MASS_REMOVAL_MIN = 20;

/**
 * Whether a source is definitely gone. Only ENOENT/ENOTDIR count: a permission
 * error, an I/O error, or a stale network mount must never delete a photo.
 */
async function sourceMissing(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return false;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR";
	}
}

/**
 * Deletes `photoIds` and every sidecar row that references them in one
 * transaction. Connections may run without foreign-key enforcement, so the
 * schema's cascades cannot be relied on: each child table is cleared here.
 * Events are recomputed by the next `detect-events-v1` run; faceless unnamed
 * people are deleted by the next `cluster-faces-v1` step. Thumbnail files are
 * left for thumbnail garbage collection.
 */
export function deletePhotos(
	database: LibraryDatabase,
	photoIds: readonly number[],
): number {
	if (photoIds.length === 0) return 0;
	return database.transaction((tx) => {
		let deleted = 0;
		for (let offset = 0; offset < photoIds.length; offset += DELETE_CHUNK) {
			const ids = photoIds.slice(offset, offset + DELETE_CHUNK);
			for (const table of [
				photoExif,
				photoEmbedding,
				photoPhash,
				collectionPhotos,
				photoTags,
				photoQuality,
				photoPlaces,
				eventPhotos,
				photoFaces,
				photoFaceScan,
			]) {
				tx.delete(table).where(inArray(table.photoId, ids)).run();
			}
			deleted += tx
				.delete(photos)
				.where(inArray(photos.id, ids))
				.returning({ id: photos.id })
				.all().length;
		}
		return deleted;
	});
}

/**
 * Removes catalog rows whose source file no longer exists. Candidates are
 * photos committed under this scan's canonical source root (or legacy rows
 * with no recorded root) that the frozen manifest (`scan_items`) did not
 * discover; each is then confirmed missing with its own `stat`, so a photo
 * hidden from discovery but still on disk is retained, and rows from another
 * library root are never touched. Refuses to delete anything when discovery
 * was empty, or (unless `allowMassRemoval`) when more than half the root's
 * catalog is missing, since both usually mean an unmounted volume.
 *
 * Idempotent: a replay after a lost checkpoint finds the rows already gone.
 */
export async function removeMissingPhotos(
	database: LibraryDatabase,
	jobId: string,
	options: { allowMassRemoval?: boolean } = {},
): Promise<RemovedPhotos> {
	const manifest = database
		.select({ sourceRoot: scanManifests.sourceRoot })
		.from(scanManifests)
		.where(eq(scanManifests.jobId, jobId))
		.get();
	const sourceRoot = manifest?.sourceRoot;
	if (!sourceRoot) return { removed: 0, retained: 0, skipped: "no-manifest" };
	const inRoot = or(
		isNull(photos.sourceRoot),
		eq(photos.sourceRoot, sourceRoot),
	);
	const candidates = database
		.select({ id: photos.id, path: photos.path })
		.from(photos)
		.where(
			and(
				inRoot,
				notExists(
					database
						.select({ ordinal: scanItems.ordinal })
						.from(scanItems)
						.where(
							and(
								eq(scanItems.jobId, jobId),
								eq(scanItems.relativePath, photos.path),
							),
						),
				),
			),
		)
		.all();
	if (candidates.length === 0) return { removed: 0, retained: 0 };
	const discovered = database
		.select({ ordinal: scanItems.ordinal })
		.from(scanItems)
		.where(eq(scanItems.jobId, jobId))
		.limit(1)
		.get();
	if (!discovered)
		return {
			removed: 0,
			retained: candidates.length,
			skipped: "empty-discovery",
		};

	const missing: number[] = [];
	for (let offset = 0; offset < candidates.length; offset += STAT_CONCURRENCY) {
		const chunk = candidates.slice(offset, offset + STAT_CONCURRENCY);
		const gone = await Promise.all(
			chunk.map((photo) => sourceMissing(join(sourceRoot, photo.path))),
		);
		chunk.forEach((photo, index) => {
			if (gone[index]) missing.push(photo.id);
		});
	}
	if (!options.allowMassRemoval && missing.length > MASS_REMOVAL_MIN) {
		const catalog = database
			.select({ id: photos.id })
			.from(photos)
			.where(inRoot)
			.all().length;
		if (missing.length > catalog * MASS_REMOVAL_FRACTION)
			return {
				removed: 0,
				retained: candidates.length,
				skipped: "mass-removal",
			};
	}
	const removed = deletePhotos(database, missing);
	return { removed, retained: candidates.length - missing.length };
}
