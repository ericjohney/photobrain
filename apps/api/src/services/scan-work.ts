import type { PhotoProcessingResult } from "@photobrain/image-processing";
import { and, asc, eq } from "drizzle-orm";
import type { db } from "../db";
import {
	type NewScanItem,
	photos,
	scanItems,
	scanJobs,
	scanManifests,
} from "../db/schema";
import { saveScanBatch } from "./import-persistence";
import type { PhotoStreamInput } from "./native-executor";

export type ScanWorkProgress = {
	total: number;
	processed: number;
	successful: number;
	pending: number;
};

export function getScanWorkProgress(
	database: typeof db,
	jobId: string,
): ScanWorkProgress {
	const manifest = database
		.select()
		.from(scanManifests)
		.where(eq(scanManifests.jobId, jobId))
		.get();
	const total = manifest?.total ?? 0;
	const processed = manifest?.processed ?? 0;
	return {
		total,
		processed,
		successful: manifest?.successful ?? 0,
		pending: total - processed,
	};
}

export function initializeScanWork(
	database: typeof db,
	jobId: string,
	discovery: { filePaths: string[]; relativePaths: string[] },
): ScanWorkProgress {
	return database.transaction((tx) => {
		const manifest = tx
			.select({ jobId: scanManifests.jobId })
			.from(scanManifests)
			.where(eq(scanManifests.jobId, jobId))
			.get();
		if (manifest) return getScanWorkProgress(database, jobId);

		const job = tx
			.select({ status: scanJobs.status })
			.from(scanJobs)
			.where(eq(scanJobs.id, jobId))
			.get();
		if (!job || job.status === "completed" || job.status === "failed") {
			return getScanWorkProgress(database, jobId);
		}
		const { filePaths, relativePaths } = discovery;
		if (filePaths.length !== relativePaths.length) {
			throw new Error("Scan discovery paths must have matching lengths");
		}

		tx.insert(scanManifests).values({ jobId, total: filePaths.length }).run();
		const existingPaths = new Set(
			tx
				.select({ path: photos.path })
				.from(photos)
				.all()
				.map((photo) => photo.path),
		);
		let ordinal = 0;
		const items: NewScanItem[] = [];
		// Stable partition determines dispatch priority, never completion order.
		for (const existing of [false, true]) {
			for (let index = 0; index < filePaths.length; index++) {
				const relativePath = relativePaths[index];
				if (existingPaths.has(relativePath) !== existing) continue;
				items.push({
					jobId,
					ordinal: ordinal++,
					filePath: filePaths[index],
					relativePath,
				});
				// Bound SQL parameters even for very large libraries.
				if (items.length === 100) {
					tx.insert(scanItems).values(items).run();
					items.length = 0;
				}
			}
		}
		if (items.length > 0) tx.insert(scanItems).values(items).run();
		return getScanWorkProgress(database, jobId);
	});
}

export function pendingScanWork(
	database: typeof db,
	jobId: string,
): PhotoStreamInput[] {
	return database
		.select({
			id: scanItems.ordinal,
			filePath: scanItems.filePath,
			relativePath: scanItems.relativePath,
		})
		.from(scanItems)
		.where(and(eq(scanItems.jobId, jobId), eq(scanItems.status, "pending")))
		.orderBy(asc(scanItems.ordinal))
		.all();
}

export function commitScanResult(
	database: typeof db,
	jobId: string,
	id: number,
	result: PhotoProcessingResult,
): ScanWorkProgress & { active: boolean; committed: boolean } {
	return database.transaction((tx) => {
		const progress = getScanWorkProgress(database, jobId);
		const job = tx
			.select({ status: scanJobs.status })
			.from(scanJobs)
			.where(eq(scanJobs.id, jobId))
			.get();
		if (!job || job.status === "completed" || job.status === "failed") {
			return { ...progress, active: false, committed: false };
		}
		const itemKey = and(eq(scanItems.jobId, jobId), eq(scanItems.ordinal, id));
		const item = tx.select().from(scanItems).where(itemKey).get();
		if (!item) throw new Error(`Unknown scan item ${jobId}:${id}`);
		if (item.status !== "pending") {
			return { ...progress, active: true, committed: false };
		}
		if (result.path !== item.relativePath) {
			throw new Error(`Scan result path does not match item ${jobId}:${id}`);
		}

		// The helper's nested Bun transaction is a savepoint inside this transaction.
		// A receipt/progress failure must also roll back photos and their sidecars.
		const [photoId] = saveScanBatch(database, [result]);
		tx.update(scanItems)
			.set({
				status: result.success ? "success" : "failed",
				photoId: photoId ?? null,
				error: result.success ? null : (result.error ?? null),
			})
			.where(itemKey)
			.run();
		const processed = progress.processed + 1;
		const successful = progress.successful + (result.success ? 1 : 0);
		tx.update(scanManifests)
			.set({ processed, successful })
			.where(eq(scanManifests.jobId, jobId))
			.run();
		tx.update(scanJobs)
			.set({
				phase: "processing",
				current: processed,
				total: progress.total,
				status: "running",
				updatedAt: new Date(),
			})
			.where(eq(scanJobs.id, jobId))
			.run();
		return {
			total: progress.total,
			processed,
			successful,
			pending: progress.total - processed,
			active: true,
			committed: true,
		};
	});
}

export function completedScanPhotoIds(
	database: typeof db,
	jobId: string,
): number[] {
	return database
		.select({ photoId: scanItems.photoId })
		.from(scanItems)
		.where(and(eq(scanItems.jobId, jobId), eq(scanItems.status, "success")))
		.orderBy(asc(scanItems.ordinal))
		.all()
		.flatMap(({ photoId }) => (photoId === null ? [] : [photoId]));
}

export function clearScanWork(database: typeof db, jobId: string): void {
	database.transaction((tx) => {
		// SQLite connections may have foreign-key enforcement disabled.
		tx.delete(scanItems).where(eq(scanItems.jobId, jobId)).run();
		tx.delete(scanManifests).where(eq(scanManifests.jobId, jobId)).run();
	});
}
