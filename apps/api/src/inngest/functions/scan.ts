import {
	discoverPhotos as discoverPhotosRust,
	type PhotoProcessingResult,
	processPhotosBatch,
} from "@photobrain/image-processing";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { photoExif, photoPhash, photos } from "@/db/schema";
import { inngest } from "../client";

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
	},
	{ event: "photos/scan.requested" },
	async ({ event, step, publish }) => {
		const { directory, thumbnailsDir, jobId } = event.data;
		console.log(`📂 Starting parallel scan of ${directory}`);

		// Publish initial status
		await publish({
			channel: `job:${jobId}`,
			topic: "progress",
			data: { phase: "discovering", current: 0, total: 0 },
		});

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

		await publish({
			channel: `job:${jobId}`,
			topic: "progress",
			data: { phase: "processing", current: 0, total: totalCount },
		});

		// Process photos in batches for better progress reporting
		const BATCH_SIZE = 20;
		let totalSuccessCount = 0;
		let totalProcessedCount = 0;

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

			// Save results to database
			let batchSuccessCount = 0;
			for (const photoResult of batchResults) {
				if (photoResult.success) {
					try {
						await saveRustPhotoToDb(photoResult);
						batchSuccessCount++;
					} catch (error) {
						console.error(`Error saving ${photoResult.path}:`, error);
					}
				}
			}

			totalSuccessCount += batchSuccessCount;
			totalProcessedCount += batchResults.length;

			// Publish progress after each batch
			await publish({
				channel: `job:${jobId}`,
				topic: "progress",
				data: {
					phase: "processing",
					current: totalProcessedCount,
					total: totalCount,
				},
			});
		}

		const result = { processed: totalProcessedCount, successful: totalSuccessCount };

		console.log(
			`✅ Scan complete: ${result.successful}/${result.processed} successful`,
		);

		// Queue embedding job if we processed photos
		if (result.successful > 0) {
			const pendingPhotos = await step.run(
				"get-pending-embeddings",
				async () => {
					return db
						.select({ id: photos.id })
						.from(photos)
						.where(eq(photos.embeddingStatus, "pending"))
						.all();
				},
			);

			if (pendingPhotos.length > 0) {
				const photoIds = pendingPhotos.map((p) => p.id);
				await step.sendEvent("trigger-embeddings", {
					name: "photos/embeddings.requested",
					data: { photoIds, thumbnailsDir, jobId },
				});
				console.log(`📊 Triggered embedding job for ${photoIds.length} photos`);
			}
		}

		await publish({
			channel: `job:${jobId}`,
			topic: "progress",
			data: {
				phase: "scan-complete",
				current: result.processed,
				total: result.processed,
			},
		});

		return result;
	},
);
