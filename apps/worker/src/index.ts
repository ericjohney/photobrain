import {
	type EmbeddingJobData,
	type PhashJobData,
	QUEUE_NAMES,
	type ScanJobData,
} from "@photobrain/utils";
import { type Job, Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import {
	generateClipEmbedding,
	saveEmbeddingToDb,
} from "./activities/embedding";
import { generatePhash, savePhashToDb } from "./activities/phash";
import {
	discoverPhotos,
	quickProcessPhoto,
	savePhotoToDb,
} from "./activities/scan";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// Shared Redis connection
const redis = new IORedis(REDIS_URL, {
	maxRetriesPerRequest: null,
});

// Create shared queue instances for adding jobs
const phashQueue = new Queue(QUEUE_NAMES.PHASH, { connection: redis });
const embeddingQueue = new Queue(QUEUE_NAMES.EMBEDDING, { connection: redis });

// Scan worker - processes directory scanning jobs
const scanWorker = new Worker<ScanJobData>(
	QUEUE_NAMES.SCAN,
	async (job: Job<ScanJobData>) => {
		const { directory, thumbnailsDir } = job.data;
		console.log(`📂 Starting scan of ${directory}`);

		// Discover all photos
		const filePaths = await discoverPhotos(directory);
		console.log(`Found ${filePaths.length} photos`);

		await job.updateProgress({ phase: "discovery", total: filePaths.length });

		let successCount = 0;

		// Process each photo
		for (let i = 0; i < filePaths.length; i++) {
			const filePath = filePaths[i];
			let savedPhoto: Awaited<ReturnType<typeof savePhotoToDb>> | undefined;

			try {
				// Quick process (thumbnails + metadata)
				const result = await quickProcessPhoto(
					filePath,
					directory,
					thumbnailsDir,
				);

				if (result.success) {
					// Save to database - returns full photo data
					savedPhoto = await savePhotoToDb(result);
					successCount++;

					// Queue phash and embedding jobs for this photo using shared queues
					await phashQueue.add(
						"generate-phash",
						{ photoId: savedPhoto.id, thumbnailsDir },
						{ jobId: `phash-${savedPhoto.id}` },
					);
					await embeddingQueue.add(
						"generate-embedding",
						{ photoId: savedPhoto.id, thumbnailsDir },
						{ jobId: `embedding-${savedPhoto.id}` },
					);
				}
			} catch (error) {
				console.error(`Error processing ${filePath}:`, error);
			}

			// Update progress with full photo data so client can add directly to cache
			await job.updateProgress({
				phase: "processing",
				current: i + 1,
				total: filePaths.length,
				photo: savedPhoto,
			});
		}

		console.log(
			`✅ Scan complete: ${successCount}/${filePaths.length} successful`,
		);
		return { processed: filePaths.length, successful: successCount };
	},
	{
		connection: redis,
		concurrency: 1, // Only one scan at a time
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

// Embedding worker - generates CLIP embeddings
const embeddingWorker = new Worker<EmbeddingJobData>(
	QUEUE_NAMES.EMBEDDING,
	async (job: Job<EmbeddingJobData>) => {
		const { photoId, thumbnailsDir } = job.data;

		try {
			const embedding = await generateClipEmbedding(photoId, thumbnailsDir);
			await saveEmbeddingToDb(photoId, embedding);

			await job.updateProgress({ photoId, status: "completed" });
			return { success: true };
		} catch (error) {
			console.error(
				`Failed to generate embedding for photo ${photoId}:`,
				error,
			);
			await job.updateProgress({ photoId, status: "failed" });
			throw error;
		}
	},
	{
		connection: redis,
		concurrency: 2, // CLIP is more memory intensive, limit concurrency
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

console.log("🚀 BullMQ workers started");
console.log(`   - Scan worker (concurrency: 1)`);
console.log(`   - Phash worker (concurrency: 4)`);
console.log(`   - Embedding worker (concurrency: 2)`);

// Keep the process running
process.on("SIGTERM", async () => {
	console.log("Shutting down workers...");
	await scanWorker.close();
	await phashWorker.close();
	await embeddingWorker.close();
	await phashQueue.close();
	await embeddingQueue.close();
	await redis.quit();
	process.exit(0);
});
