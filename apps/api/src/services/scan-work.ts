import type { PhotoProcessingResult } from "@photobrain/image-processing";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { db } from "../db";
import {
	type NewScanItem,
	photoEmbedding,
	photos,
	scanItems,
	scanJobs,
	scanManifests,
} from "../db/schema";
import { type ProcessedMediaState, saveScanBatch } from "./import-persistence";
import type { PhotoStreamInput } from "./native-executor";
import { EMBEDDING_MODEL_VERSION, MEDIA_VERSION } from "./processing-versions";
import {
	type ScanPlan,
	sourceIdentity,
	thumbnailIdentity,
} from "./scan-planner";

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
	plan: ScanPlan,
): ScanWorkProgress {
	return database.transaction((tx) => {
		if (
			tx
				.select()
				.from(scanManifests)
				.where(eq(scanManifests.jobId, jobId))
				.get()
		) {
			return getScanWorkProgress(database, jobId);
		}
		const job = tx.select().from(scanJobs).where(eq(scanJobs.id, jobId)).get();
		if (!job || job.status === "completed" || job.status === "failed")
			return getScanWorkProgress(database, jobId);
		// Read one transactional snapshot rather than two queries per unchanged photo.
		const currentPhotos = new Map(
			tx
				.select({
					id: photos.id,
					path: photos.path,
					thumbnailKey: photos.thumbnailKey,
					sourceFingerprint: photos.sourceFingerprint,
					embeddingStatus: photos.embeddingStatus,
				})
				.from(photos)
				.all()
				.map((photo) => [photo.path, photo]),
		);
		const currentVectors = new Map(
			tx
				.select({
					photoId: photoEmbedding.photoId,
					thumbnailKey: photoEmbedding.thumbnailKey,
					modelVersion: photoEmbedding.modelVersion,
					bytes: sql<number>`length(${photoEmbedding.embedding})`,
				})
				.from(photoEmbedding)
				.all()
				.map((vector) => [vector.photoId, vector]),
		);
		const items: NewScanItem[] = [];
		let processed = 0;
		let successful = 0;
		let unchanged = 0;
		let media = 0;
		let embedding = 0;
		let ordinal = 0;
		// Preserve new-first dispatch without imposing completion barriers.
		for (const existing of [false, true]) {
			for (const planned of plan.items) {
				if ((planned.photoId !== null) !== existing) continue;
				let action: string = planned.action;
				let status = action === "media" ? "pending" : "failed";
				if (action === "reuse") {
					const photo = currentPhotos.get(planned.relativePath);
					if (
						!photo ||
						photo.id !== planned.photoId ||
						photo.thumbnailKey !== planned.previousThumbnailKey ||
						photo.sourceFingerprint !== planned.previousSourceFingerprint
					) {
						throw new Error(
							"Photo changed while planning the scan; retry initialization",
						);
					}
					const vector = currentVectors.get(photo.id);
					const vectorCurrent =
						photo.embeddingStatus === "completed" &&
						vector?.modelVersion === EMBEDDING_MODEL_VERSION &&
						vector.bytes === 2048 &&
						vector.thumbnailKey === photo.thumbnailKey;
					if (planned.adopt) {
						tx.update(photos)
							.set({
								sourceRoot: plan.sourceRoot,
								sourceFingerprint: planned.sourceFingerprint,
								mediaVersion: MEDIA_VERSION,
								thumbnailKey: planned.thumbnailKey,
								thumbnailRoot: plan.thumbnailsRoot,
								thumbnailFingerprint: planned.thumbnailFingerprint,
							})
							.where(eq(photos.id, photo.id))
							.run();
						if (vectorCurrent)
							tx.update(photoEmbedding)
								.set({ thumbnailKey: planned.thumbnailKey })
								.where(eq(photoEmbedding.photoId, photo.id))
								.run();
					}
					action = vectorCurrent ? "skip" : "embed";
					if (!vectorCurrent && photo.embeddingStatus !== "pending") {
						tx.update(photos)
							.set({ embeddingStatus: "pending" })
							.where(eq(photos.id, photo.id))
							.run();
					}
					status = "success";
					unchanged++;
					successful++;
					if (!vectorCurrent) embedding++;
				}
				if (action === "media") media++;
				else processed++;
				items.push({
					jobId,
					ordinal: ordinal++,
					filePath: planned.filePath,
					relativePath: planned.relativePath,
					photoId: planned.photoId,
					action,
					status,
					error: planned.error,
					sourceFingerprint: planned.sourceFingerprint,
					thumbnailKey: planned.thumbnailKey,
					previousThumbnailKey: planned.previousThumbnailKey,
					previousSourceFingerprint: planned.previousSourceFingerprint,
				});
			}
		}
		tx.insert(scanManifests)
			.values({
				jobId,
				total: items.length,
				processed,
				successful,
				unchanged,
				media,
				embedding,
				sourceRoot: plan.sourceRoot,
				thumbnailsRoot: plan.thumbnailsRoot,
			})
			.run();
		for (let offset = 0; offset < items.length; offset += 100) {
			tx.insert(scanItems)
				.values(items.slice(offset, offset + 100))
				.run();
		}
		return getScanWorkProgress(database, jobId);
	});
}

export function pendingScanWork(
	database: typeof db,
	jobId: string,
): PhotoStreamInput[] {
	return database.transaction((tx) => {
		const pending = tx
			.select()
			.from(scanItems)
			.where(and(eq(scanItems.jobId, jobId), eq(scanItems.status, "pending")))
			.orderBy(asc(scanItems.ordinal))
			.all();
		return pending.map((item) => {
			// A restart gets a fresh output directory, fencing still-running older writers.
			const thumbnailKey = `.versions/${crypto.randomUUID()}/photo.image`;
			tx.update(scanItems)
				.set({ thumbnailKey })
				.where(
					and(eq(scanItems.jobId, jobId), eq(scanItems.ordinal, item.ordinal)),
				)
				.run();
			return {
				id: item.ordinal,
				filePath: item.filePath,
				relativePath: item.relativePath,
				thumbnailKey,
			};
		});
	});
}

export async function commitScanResult(
	database: typeof db,
	jobId: string,
	id: number,
	result: PhotoProcessingResult,
	thumbnailKey: string | undefined,
): Promise<ScanWorkProgress & { active: boolean; committed: boolean }> {
	const itemKey = and(eq(scanItems.jobId, jobId), eq(scanItems.ordinal, id));
	const planned = database.select().from(scanItems).where(itemKey).get();
	const manifest = database
		.select()
		.from(scanManifests)
		.where(eq(scanManifests.jobId, jobId))
		.get();
	let mediaState: ProcessedMediaState | undefined;
	let failure = result.success
		? undefined
		: (result.error ?? "Media processing failed");
	if (
		planned?.status === "pending" &&
		planned.thumbnailKey === thumbnailKey &&
		result.success
	) {
		try {
			if (!thumbnailKey || !manifest?.sourceRoot || !manifest.thumbnailsRoot)
				throw new Error("Missing media generation identity");
			const source = await sourceIdentity(planned.filePath);
			if (source.fingerprint !== planned.sourceFingerprint)
				throw new Error("Source changed during processing; scan again");
			mediaState = {
				sourceRoot: manifest.sourceRoot,
				sourceFingerprint: source.fingerprint,
				mediaVersion: MEDIA_VERSION,
				thumbnailKey,
				thumbnailRoot: manifest.thumbnailsRoot,
				thumbnailFingerprint: await thumbnailIdentity(
					manifest.thumbnailsRoot,
					thumbnailKey,
				),
			};
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
	}
	return database.transaction((tx) => {
		const progress = getScanWorkProgress(database, jobId);
		const job = tx.select().from(scanJobs).where(eq(scanJobs.id, jobId)).get();
		if (!job || job.status === "completed" || job.status === "failed")
			return { ...progress, active: false, committed: false };
		const item = tx.select().from(scanItems).where(itemKey).get();
		if (!item) throw new Error(`Unknown scan item ${jobId}:${id}`);
		if (item.status !== "pending" || item.thumbnailKey !== thumbnailKey)
			return { ...progress, active: true, committed: false };
		if (result.path !== item.relativePath)
			throw new Error(`Scan result path does not match item ${jobId}:${id}`);
		const current = tx
			.select()
			.from(photos)
			.where(eq(photos.path, item.relativePath))
			.get();
		if (
			(current?.id ?? null) !== item.photoId ||
			(current?.thumbnailKey ?? null) !== item.previousThumbnailKey ||
			(current?.sourceFingerprint ?? null) !== item.previousSourceFingerprint
		) {
			failure = "A newer media generation was committed by another scan";
		}
		const succeeded = !failure && mediaState !== undefined;
		let photoId: number | null = null;
		if (succeeded && mediaState) {
			[photoId] = saveScanBatch(
				database,
				[result],
				new Map([[result.path, mediaState]]),
			);
		}
		tx.update(scanItems)
			.set({
				status: succeeded ? "success" : "failed",
				photoId,
				error: failure ?? (succeeded ? null : "Missing media generation"),
			})
			.where(itemKey)
			.run();
		const processed = progress.processed + 1;
		const successful = progress.successful + Number(succeeded);
		tx.update(scanManifests)
			.set({
				processed,
				successful,
				embedding: sql`${scanManifests.embedding} + ${Number(succeeded)}`,
			})
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

export function scanEmbeddingPhotoIds(
	database: typeof db,
	jobId: string,
): number[] {
	return database
		.select({ photoId: photos.id })
		.from(scanItems)
		.innerJoin(
			photos,
			and(
				eq(photos.id, scanItems.photoId),
				eq(photos.thumbnailKey, scanItems.thumbnailKey),
			),
		)
		.leftJoin(photoEmbedding, eq(photoEmbedding.photoId, photos.id))
		.where(
			and(
				eq(scanItems.jobId, jobId),
				eq(scanItems.status, "success"),
				inArray(scanItems.action, ["media", "embed"]),
				sql`(${photos.embeddingStatus} IS NOT 'completed' OR ${photoEmbedding.id} IS NULL OR ${photoEmbedding.thumbnailKey} IS NOT ${photos.thumbnailKey} OR ${photoEmbedding.modelVersion} IS NOT ${EMBEDDING_MODEL_VERSION} OR length(${photoEmbedding.embedding}) != 2048)`,
			),
		)
		.orderBy(asc(scanItems.ordinal))
		.all()
		.map((row) => row.photoId);
}

export function clearScanWork(database: typeof db, jobId: string): void {
	database.transaction((tx) => {
		// SQLite connections may have foreign-key enforcement disabled.
		tx.delete(scanItems).where(eq(scanItems.jobId, jobId)).run();
		tx.delete(scanManifests).where(eq(scanManifests.jobId, jobId)).run();
	});
}
