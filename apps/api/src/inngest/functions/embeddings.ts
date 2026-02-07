import path from "node:path";
import { batchGenerateClipEmbeddings } from "@photobrain/image-processing";
import { getThumbnailPath } from "@photobrain/utils";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { photoEmbedding, photos } from "@/db/schema";
import { inngest } from "../client";

const BATCH_SIZE = 16;

export const generateEmbeddingsFunction = inngest.createFunction(
	{
		id: "generate-embeddings",
		concurrency: { limit: 1 },
	},
	{ event: "photos/embeddings.requested" },
	async ({ event, step, publish }) => {
		const { photoIds, thumbnailsDir, jobId } = event.data;

		console.log(`🧠 Starting batch embedding for ${photoIds.length} photos`);

		await publish({
			channel: `job:${jobId}`,
			topic: "progress",
			data: { phase: "embedding", current: 0, total: photoIds.length },
		});

		// Get photo paths from database
		const photoData = await step.run("get-photo-paths", async () => {
			return db
				.select({ id: photos.id, path: photos.path })
				.from(photos)
				.where(inArray(photos.id, photoIds))
				.all();
		});

		if (photoData.length === 0) {
			console.log("No photos found for embedding (may have been deleted)");
			return { processed: 0, successful: 0 };
		}

		let processedCount = 0;
		let successCount = 0;

		// Process in batches
		const batches = [];
		for (let i = 0; i < photoData.length; i += BATCH_SIZE) {
			batches.push(photoData.slice(i, i + BATCH_SIZE));
		}

		for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
			const batch = batches[batchIndex];

			const batchResult = await step.run(
				`process-batch-${batchIndex}`,
				async () => {
					const thumbnailPaths = batch.map((p) =>
						path.join(thumbnailsDir, getThumbnailPath(p.path, "large")),
					);

					const embeddings = batchGenerateClipEmbeddings(thumbnailPaths);

					let batchSuccess = 0;
					for (let j = 0; j < batch.length; j++) {
						const photoId = batch[j].id;
						const embedding = embeddings[j];

						if (embedding) {
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
							batchSuccess++;
						} else {
							await db
								.update(photos)
								.set({ embeddingStatus: "failed" })
								.where(eq(photos.id, photoId));
						}
					}

					return { processed: batch.length, successful: batchSuccess };
				},
			);

			processedCount += batchResult.processed;
			successCount += batchResult.successful;

			await publish({
				channel: `job:${jobId}`,
				topic: "progress",
				data: {
					phase: "embedding",
					current: processedCount,
					total: photoData.length,
				},
			});

			if (processedCount % 64 === 0 || processedCount === photoData.length) {
				console.log(
					`  Embedding progress: ${processedCount}/${photoData.length}`,
				);
			}
		}

		console.log(
			`✅ Batch embedding complete: ${successCount}/${photoData.length} successful`,
		);

		await publish({
			channel: `job:${jobId}`,
			topic: "progress",
			data: {
				phase: "completed",
				current: processedCount,
				total: processedCount,
			},
		});

		return { processed: photoData.length, successful: successCount };
	},
);
