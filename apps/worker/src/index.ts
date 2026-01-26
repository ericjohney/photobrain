import path from "node:path";
import {
	batchGenerateClipEmbeddings,
	discoverPhotos as discoverPhotosRust,
	processPhotosWithCallback,
} from "@photobrain/image-processing";
import {
	type BatchEmbeddingJobData,
	getThumbnailPath,
	type PhashJobData,
	QUEUE_NAMES,
	type ScanJobData,
} from "@photobrain/utils";
import { type Job, Queue, Worker } from "bullmq";
import { eq, inArray } from "drizzle-orm";
import IORedis from "ioredis";
import { generatePhash, savePhashToDb } from "./activities/phash";
import { saveRustPhotoToDb } from "./activities/scan";
import { db, photoEmbedding, photos } from "./db";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Shared Redis connection
const redis = new IORedis(REDIS_URL, {
	maxRetriesPerRequest: null,
});

// Queue for adding batch embedding jobs
const embeddingQueue = new Queue(QUEUE_NAMES.EMBEDDING, { connection: redis });

// Scan worker - processes directory scanning jobs with parallel processing
const scanWorker = new Worker<ScanJobData>(
	QUEUE_NAMES.SCAN,
	async (job: Job<ScanJobData>) => {
		const { directory, thumbnailsDir } = job.data;
		console.log(`📂 Starting parallel scan of ${directory}`);

		// Fast parallel discovery in Rust
		const discovery = discoverPhotosRust(directory);
		const { filePaths, relativePaths, totalCount } = discovery;
		console.log(`Found ${totalCount} photos (parallel discovery)`);

		await job.updateProgress({ phase: "discovery", total: totalCount });

		let successCount = 0;
		let processedCount = 0;
		let completedCount = 0;

		// Create a promise that resolves when all photos are processed
		const processingComplete = new Promise<void>((resolve) => {
			// Process all photos in parallel with streaming callback
			// Rust calls this callback synchronously for each completed photo
			// The Blocking mode means Rust waits for callback to return
			processPhotosWithCallback(
				filePaths,
				relativePaths,
				thumbnailsDir,
				// Note: NAPI ThreadsafeFunction calls with (err, result) signature
				(_err, result) => {
					processedCount++;
					const myIndex = processedCount;

					// Log progress every 50 photos
					if (myIndex % 50 === 0 || myIndex === 1) {
						console.log(`Processing ${myIndex}/${totalCount}...`);
					}

					// Fire-and-forget the async work
					// We track completion separately
					(async () => {
						let savedPhoto:
							| Awaited<ReturnType<typeof saveRustPhotoToDb>>
							| undefined;

						try {
							if (result && result.success) {
								// Save to database (includes phash from Rust)
								savedPhoto = await saveRustPhotoToDb(result);
								successCount++;
							}
						} catch (error) {
							console.error(
								`Error saving ${result?.path ?? "unknown"}:`,
								error,
							);
						} finally {
							// Stream to UI immediately (ignore errors if lock lost)
							try {
								await job.updateProgress({
									phase: "processing",
									current: processedCount,
									total: totalCount,
									photo: savedPhoto,
								});
							} catch {
								// Ignore progress update errors (lock may be lost)
							}

							// Track completion (always increment, even on error)
							completedCount++;
							if (completedCount % 50 === 0) {
								console.log(`Completed ${completedCount}/${totalCount}`);
							}
							if (completedCount >= totalCount) {
								console.log(`All ${totalCount} photos processed!`);
								resolve();
							}
						}
					})();
				},
			);

			// Handle edge case of empty directory
			if (totalCount === 0) {
				resolve();
			}
		});

		// Wait for all async work to complete
		await processingComplete;

		console.log(`✅ Scan complete: ${successCount}/${totalCount} successful`);

		// Queue batch embedding job for all photos that need embeddings
		// Note: This queries ALL pending photos, not just from this scan.
		// This provides automatic retry for any previously failed embeddings.
		if (successCount > 0) {
			const pendingPhotos = await db
				.select({ id: photos.id })
				.from(photos)
				.where(eq(photos.embeddingStatus, "pending"))
				.all();

			if (pendingPhotos.length > 0) {
				const photoIds = pendingPhotos.map((p) => p.id);
				await embeddingQueue.add(
					"batch-embedding",
					{ photoIds, thumbnailsDir },
					{ jobId: `batch-embedding-${Date.now()}` },
				);
				console.log(
					`📊 Queued batch embedding job for ${photoIds.length} photos`,
				);
			}
		}

		return { processed: totalCount, successful: successCount };
	},
	{
		connection: redis,
		concurrency: 1, // Only one scan at a time
		lockDuration: 300000, // 5 minutes - scans can take a while
	},
);

// Phash worker - generates perceptual hashes
const phashWorker = new Worker<PhashJobData>(
	QUEUE_NAMES.PHASH,
	async (job: Job<PhashJobData>) => {
		const { photoId, thumbnailsDir } = job.data;

		try {
			const hash = await generatePhash(photoId, thumbnailsDir);
			await savePhashToDb(photoId, hash);

			await job.updateProgress({ photoId, status: "completed" });
			return { success: true, hash };
		} catch (error) {
			console.error(`Failed to generate phash for photo ${photoId}:`, error);
			await job.updateProgress({ photoId, status: "failed" });
			throw error;
		}
	},
	{
		connection: redis,
		concurrency: 4, // Process multiple phash jobs in parallel
	},
);

// Batch embedding worker - generates CLIP embeddings for multiple photos at once
const embeddingWorker = new Worker<BatchEmbeddingJobData>(
	QUEUE_NAMES.EMBEDDING,
	async (job: Job<BatchEmbeddingJobData>) => {
		const { photoIds, thumbnailsDir } = job.data;
		const BATCH_SIZE = 16; // Process 16 images at a time through CLIP

		console.log(`🧠 Starting batch embedding for ${photoIds.length} photos`);

		// Get photo paths from database
		const photoData = await db
			.select({ id: photos.id, path: photos.path })
			.from(photos)
			.where(inArray(photos.id, photoIds))
			.all();

		if (photoData.length === 0) {
			console.log("No photos found for embedding (may have been deleted)");
			return { processed: 0, successful: 0 };
		}

		let processedCount = 0;
		let successCount = 0;

		// Process in batches
		for (let i = 0; i < photoData.length; i += BATCH_SIZE) {
			const batch = photoData.slice(i, i + BATCH_SIZE);
			const thumbnailPaths = batch.map((p) =>
				path.join(thumbnailsDir, getThumbnailPath(p.path, "large")),
			);

			// Call Rust batch function
			const embeddings = batchGenerateClipEmbeddings(thumbnailPaths);

			// Save each embedding to database
			for (let j = 0; j < batch.length; j++) {
				const photoId = batch[j].id;
				const embedding = embeddings[j];

				if (embedding) {
					// Delete existing and insert new
					await db
						.delete(photoEmbedding)
						.where(eq(photoEmbedding.photoId, photoId));
					await db.insert(photoEmbedding).values({
						photoId,
						embedding: Buffer.from(new Float32Array(embedding).buffer),
						modelVersion: "clip-vit-b32",
						createdAt: new Date(),
					});
					await db
						.update(photos)
						.set({ embeddingStatus: "completed" })
						.where(eq(photos.id, photoId));
					successCount++;
				} else {
					await db
						.update(photos)
						.set({ embeddingStatus: "failed" })
						.where(eq(photos.id, photoId));
				}
				processedCount++;
			}

			// Update progress (using consistent format with scan job)
			await job.updateProgress({
				phase: "embedding",
				current: processedCount,
				total: photoData.length,
				successful: successCount,
			});

			// Log every 64 photos processed
			if (processedCount % 64 === 0 || processedCount === photoData.length) {
				console.log(
					`  Embedding progress: ${processedCount}/${photoData.length}`,
				);
			}
		}

		console.log(
			`✅ Batch embedding complete: ${successCount}/${photoData.length} successful`,
		);
		return { processed: photoData.length, successful: successCount };
	},
	{
		connection: redis,
		concurrency: 1, // Only one batch at a time (CLIP memory intensive)
	},
);

// Handle worker events
for (const worker of [scanWorker, phashWorker, embeddingWorker]) {
	worker.on("completed", (job) => {
		console.log(`✅ Job ${job.id} completed`);
	});

	worker.on("failed", (job, err) => {
		console.error(`❌ Job ${job?.id} failed:`, err.message);
	});

	worker.on("error", (err) => {
		console.error("Worker error:", err);
	});
}

console.log("🚀 BullMQ workers started (with parallel photo processing)");
console.log(`   - Scan worker (concurrency: 1, parallel Rust processing)`);
console.log(`   - Phash worker (concurrency: 4)`);
console.log(`   - Batch embedding worker (concurrency: 1, batch size: 16)`);

// Keep the process running
process.on("SIGTERM", async () => {
	console.log("Shutting down workers...");
	await scanWorker.close();
	await phashWorker.close();
	await embeddingWorker.close();
	await embeddingQueue.close();
	await redis.quit();
	process.exit(0);
});
