import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAllThumbnailSizes } from "@photobrain/utils";
import { sql } from "drizzle-orm";
import type { db } from "../db";
import { scanManifests } from "../db/schema";

type GcDatabase = typeof db;

/**
 * Generations younger than this are never collected: a cancelled native
 * writer, or a scan whose attempt key was just assigned, may still be writing.
 */
export const THUMBNAIL_GC_GRACE_MS = 6 * 60 * 60 * 1000;

const VERSIONS_DIR = ".versions";
/** Managed keys are `.versions/{uuid}/photo.image` (see `pendingScanWork`). */
const MANAGED_KEY = /^\.versions\/([^/]+)\//;

export type ThumbnailGcResult = {
	/** Generation directories deleted, summed over sizes. */
	deleted: number;
	/** Bytes freed (file sizes, not allocated blocks). */
	bytes: number;
	/** Unreferenced generations kept because they are inside the grace period. */
	recent: number;
	/** Set when collection refused to run. */
	skipped?: "scan-in-progress";
};

/**
 * Every managed generation still referenced: committed photo artifacts, the
 * generations face crops render from (a face keeps its own generation until it
 * is re-detected), and scan receipts' current and previous attempts.
 */
function referencedGenerations(database: GcDatabase): Set<string> {
	const rows = database.all<{ key: string }>(sql`
		SELECT thumbnail_key AS key FROM photos WHERE thumbnail_key IS NOT NULL
		UNION SELECT thumbnail_key FROM photo_faces
		UNION SELECT thumbnail_key FROM photo_face_scan
		UNION SELECT thumbnail_key FROM photo_quality
		UNION SELECT thumbnail_key FROM scan_items WHERE thumbnail_key IS NOT NULL
		UNION SELECT previous_thumbnail_key FROM scan_items
			WHERE previous_thumbnail_key IS NOT NULL
	`);
	const ids = new Set<string>();
	for (const { key } of rows) {
		const match = MANAGED_KEY.exec(key);
		if (match) ids.add(match[1]);
	}
	return ids;
}

/** Total file bytes under `directory` (lstat; symlinks are not followed). */
async function directoryBytes(directory: string): Promise<number> {
	let total = 0;
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = join(directory, entry.name);
		if (entry.isDirectory()) total += await directoryBytes(entryPath);
		else total += (await lstat(entryPath)).size;
	}
	return total;
}

/**
 * Deletes managed thumbnail generations (`{root}/{size}/.versions/{uuid}/`)
 * that no row references: superseded generations after a reprocess, attempts
 * abandoned by a retry or crash, and generations of photos removed from the
 * library. Legacy mirrored thumbnails outside `.versions` are never touched.
 *
 * Refuses to run while any scan manifest exists, because a running scan's
 * attempt keys and in-flight writers are only fenced by those receipts. The
 * reference set is read before listing directories, so a generation committed
 * afterwards is at most `THUMBNAIL_GC_GRACE_MS` old and is kept.
 */
export async function collectThumbnailGarbage(
	database: GcDatabase,
	defaultRoot: string,
	now = Date.now(),
): Promise<ThumbnailGcResult> {
	const result: ThumbnailGcResult = { deleted: 0, bytes: 0, recent: 0 };
	if (database.select().from(scanManifests).limit(1).get())
		return { ...result, skipped: "scan-in-progress" };
	const referenced = referencedGenerations(database);
	const roots = new Set([resolve(defaultRoot)]);
	for (const { root } of database.all<{ root: string }>(
		sql`SELECT DISTINCT thumbnail_root AS root FROM photos WHERE thumbnail_root IS NOT NULL`,
	))
		roots.add(resolve(root));

	for (const root of roots) {
		for (const size of getAllThumbnailSizes()) {
			const versions = join(root, size, VERSIONS_DIR);
			let entries: string[];
			try {
				entries = await readdir(versions);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			for (const name of entries) {
				if (referenced.has(name)) continue;
				const generation = join(versions, name);
				const metadata = await lstat(generation);
				if (!metadata.isDirectory()) continue;
				if (now - metadata.mtimeMs < THUMBNAIL_GC_GRACE_MS) {
					result.recent++;
					continue;
				}
				result.bytes += await directoryBytes(generation);
				await rm(generation, { recursive: true, force: true });
				result.deleted++;
			}
		}
	}
	return result;
}
