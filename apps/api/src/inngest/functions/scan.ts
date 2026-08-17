import {
	discoverPhotos as discoverPhotosRust,
	type PhotoProcessingResult,
	processPhotosBatch,
} from "@photobrain/image-processing";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { photoExif, photoPhash, photos } from "../../db/schema";
import { inngest } from "../client";
import { failJob, updateJobProgress } from "../progress";

interface SavePhotoResult {
	id: number;
	path: string;
	name: string;
	size: number;
	createdAt: Date;
	modifiedAt: Date;
	width: number | null;
	height: number | null;
	mimeType: string | null;
	isRaw: boolean;
	rawFormat: string | null;
	rawStatus: string | null;
	exif: {
		cameraMake?: string | null;
		cameraModel?: string | null;
		lensMake?: string | null;
		lensModel?: string | null;
		focalLength?: number | null;
		iso?: number | null;
		aperture?: string | null;
		shutterSpeed?: string | null;
		exposureBias?: string | null;
		dateTaken?: string | null;
		gpsLatitude?: string | null;
		gpsLongitude?: string | null;
		gpsAltitude?: string | null;
	} | null;
}

// Helper to convert number GPS coordinates to string (for database storage)
function gpsToString(value: number | undefined): string | null {
	return value !== undefined ? String(value) : null;
}

async function saveRustPhotoToDb(
	result: PhotoProcessingResult,
): Promise<SavePhotoResult> {
	const existing = await db
		.select({ id: photos.id })
		.from(photos)
		.where(eq(photos.path, result.path))
		.get();

	let photoId: number;

	if (existing) {
		await db
			.update(photos)
			.set({
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
				thumbnailUpdatedAt: new Date(),
				embeddingStatus: "pending",
				phashStatus: result.phash ? "completed" : "failed",
			})
			.where(eq(photos.id, existing.id));
		photoId = existing.id;
	} else {
		const inserted = await db
			.insert(photos)
			.values({
				path: result.path,
				name: result.name,
				size: result.size,
				createdAt: new Date(result.createdAt),
				modifiedAt: new Date(result.modifiedAt),
				width: result.width ?? null,
				height: result.height ?? null,
				mimeType: result.mimeType ?? null,
				isRaw: result.isRaw,
				rawFormat: result.rawFormat ?? null,
				rawStatus: result.rawStatus ?? null,
				rawError: result.rawError ?? null,
				thumbnailStatus: "completed",
				thumbnailUpdatedAt: new Date(),
				embeddingStatus: "pending",
				phashStatus: result.phash ? "completed" : "failed",
			})
			.returning({ id: photos.id });
		photoId = inserted[0].id;
	}

	if (result.exif) {
		await db.delete(photoExif).where(eq(photoExif.photoId, photoId));
		await db.insert(photoExif).values({
			photoId,
			cameraMake: result.exif.cameraMake ?? null,
			cameraModel: result.exif.cameraModel ?? null,
			lensMake: result.exif.lensMake ?? null,
			lensModel: result.exif.lensModel ?? null,
			focalLength: result.exif.focalLength ?? null,
			iso: result.exif.iso ?? null,
			aperture: result.exif.aperture ?? null,
			shutterSpeed: result.exif.shutterSpeed ?? null,
			exposureBias: result.exif.exposureBias ?? null,
			dateTaken: result.exif.dateTaken ?? null,
			gpsLatitude: gpsToString(result.exif.gpsLatitude),
			gpsLongitude: gpsToString(result.exif.gpsLongitude),
			gpsAltitude: gpsToString(result.exif.gpsAltitude),
		});
	}

	if (result.phash) {
		await db.delete(photoPhash).where(eq(photoPhash.photoId, photoId));
		await db.insert(photoPhash).values({
			photoId,
			hash: result.phash,
			algorithm: "double_gradient_8x8",
			createdAt: new Date(),
		});
	}

	return {
		id: photoId,
		path: result.path,
		name: result.name,
		size: result.size,
		createdAt: new Date(result.createdAt),
		modifiedAt: new Date(result.modifiedAt),
		width: result.width ?? null,
		height: result.height ?? null,
		mimeType: result.mimeType ?? null,
		isRaw: result.isRaw,
		rawFormat: result.rawFormat ?? null,
		rawStatus: result.isRaw ? "converted" : null,
		exif: result.exif
			? {
					cameraMake: result.exif.cameraMake ?? null,
					cameraModel: result.exif.cameraModel ?? null,
					lensMake: result.exif.lensMake ?? null,
					lensModel: result.exif.lensModel ?? null,
					focalLength: result.exif.focalLength ?? null,
					iso: result.exif.iso ?? null,
					aperture: result.exif.aperture ?? null,
					shutterSpeed: result.exif.shutterSpeed ?? null,
					exposureBias: result.exif.exposureBias ?? null,
					dateTaken: result.exif.dateTaken ?? null,
					gpsLatitude: gpsToString(result.exif.gpsLatitude),
					gpsLongitude: gpsToString(result.exif.gpsLongitude),
					gpsAltitude: gpsToString(result.exif.gpsAltitude),
				}
			: null,
	};
}

export const scanPhotosFunction = inngest.createFunction(
	{
		id: "scan-photos",
		concurrency: { limit: 1 },
		onFailure: async ({ event, error, publish, step }) => {
			const jobId = event.data.event.data.jobId;
			const failedJob = await step.run("persist-terminal-failure", () =>
				failJob(jobId, error),
			);
			if (!failedJob) return;
			try {
				await publish({
					channel: `job:${jobId}`,
					topic: "progress",
					data: { phase: "failed", ...failedJob },
				});
			} catch (publishError) {
				console.error(`Failed to publish failure for ${jobId}:`, publishError);
			}
		},
	},
	{ event: "photos/scan.requested" },
	async ({ event, step, publish }) => {
		const { directory, thumbnailsDir, jobId } = event.data;
		const publishProgress = async (data: {
			phase: string;
			current: number;
			total: number;
		}) => {
			try {
				await publish({ channel: `job:${jobId}`, topic: "progress", data });
			} catch (error) {
				console.error(`Failed to publish progress for ${jobId}:`, error);
			}
		};
		console.log(`📂 Starting parallel scan of ${directory}`);

		// Publish initial status
		const jobStarted = await step.run("claim-scan-job-v2", () =>
			updateJobProgress(jobId, "discovering", 0, 0),
		);
		if (!jobStarted) {
			console.warn(`Skipping scan for missing or terminal job ${jobId}`);
			return { processed: 0, successful: 0 };
		}
		await publishProgress({ phase: "discovering", current: 0, total: 0 });

		// Discovery step - wrapped in step.run for checkpointing
		const discovery = await step.run("discover-photos", async () => {
			const result = discoverPhotosRust(directory);
			return {
				filePaths: result.filePaths,
				relativePaths: result.relativePaths,
				totalCount: result.totalCount,
			};
		});

		const { filePaths, relativePaths, totalCount } = discovery;
		console.log(`Found ${totalCount} photos`);

		await step.run("mark-processing", () =>
			updateJobProgress(jobId, "processing", 0, totalCount),
		);
		await publishProgress({
			phase: "processing",
			current: 0,
			total: totalCount,
		});

		// Process photos in batches for better progress reporting
		const BATCH_SIZE = 20;
		let totalSuccessCount = 0;
		let totalProcessedCount = 0;
		const savedPhotoIds: number[] = [];

		for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
			const batchNum = Math.floor(i / BATCH_SIZE);
			const batchFilePaths = filePaths.slice(i, i + BATCH_SIZE);
			const batchRelativePaths = relativePaths.slice(i, i + BATCH_SIZE);

			const batchResults = await step.run(
				`process-batch-${batchNum}`,
				async () => {
					console.log(
						`Processing batch ${batchNum + 1}/${Math.ceil(filePaths.length / BATCH_SIZE)}...`,
					);
					return processPhotosBatch(
						batchFilePaths,
						batchRelativePaths,
						thumbnailsDir,
					);
				},
			);

			const batchPhotoIds = await step.run(
				`save-batch-${batchNum}`,
				async () => {
					const photoIds: number[] = [];
					for (const photoResult of batchResults) {
						if (!photoResult.success) continue;
						const savedPhoto = await saveRustPhotoToDb(photoResult);
						photoIds.push(savedPhoto.id);
					}
					return photoIds;
				},
			);

			totalSuccessCount += batchPhotoIds.length;
			totalProcessedCount += batchResults.length;
			savedPhotoIds.push(...batchPhotoIds);

			// Publish progress after each batch
			await step.run(`mark-batch-${batchNum}-processed`, () =>
				updateJobProgress(jobId, "processing", totalProcessedCount, totalCount),
			);
			await publishProgress({
				phase: "processing",
				current: totalProcessedCount,
				total: totalCount,
			});
		}

		const result = {
			processed: totalProcessedCount,
			successful: totalSuccessCount,
		};

		console.log(
			`✅ Scan complete: ${result.successful}/${result.processed} successful`,
		);

		if (result.processed > 0 && result.successful === 0) {
			const error = new Error("No photos could be processed");
			await step.run("mark-scan-failed", () => failJob(jobId, error));
			await publishProgress({
				phase: "failed",
				current: result.processed,
				total: result.processed,
			});
			return result;
		}

		const finalPhase = savedPhotoIds.length > 0 ? "scan-complete" : "completed";
		await step.run("mark-scan-finished", () =>
			updateJobProgress(jobId, finalPhase, result.processed, result.processed),
		);
		await publishProgress({
			phase: finalPhase,
			current: result.processed,
			total: result.processed,
		});

		// This must remain the final side effect in the parent function. The child
		// can complete immediately, so writing scan-complete afterward would regress it.
		if (savedPhotoIds.length > 0) {
			await step.sendEvent("trigger-embeddings", {
				name: "photos/embeddings.requested",
				data: { photoIds: savedPhotoIds, thumbnailsDir, jobId },
			});
			console.log(
				`📊 Triggered embedding job for ${savedPhotoIds.length} photos`,
			);
		}

		return result;
	},
);
