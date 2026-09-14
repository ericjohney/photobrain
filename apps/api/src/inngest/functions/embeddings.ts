import path from "node:path";
import { getThumbnailPath } from "@photobrain/utils";
import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { photos } from "../../db/schema";
import { saveEmbeddingBatch } from "../../services/import-persistence";
import { nativeExecutor } from "../../services/native-executor";
import { inngest } from "../client";
import { failJob, updateJobProgress } from "../progress";

const BATCH_SIZE = 16;

export const generateEmbeddingsFunction = inngest.createFunction(
	{
		id: "generate-embeddings",
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
	{ event: "photos/embeddings.requested" },
	async ({ event, step, publish }) => {
		const { photoIds, thumbnailsDir, jobId } = event.data;
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

		console.log(`🧠 Starting batch embedding for ${photoIds.length} photos`);
		const jobStarted = await step.run("claim-embedding-job-v2", () =>
			updateJobProgress(jobId, "embedding", 0, photoIds.length),
		);
		if (!jobStarted) {
			console.warn(`Skipping embeddings for missing or terminal job ${jobId}`);
			return { processed: 0, successful: 0 };
		}

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
			await step.run("mark-empty-embedding-completed", () =>
				updateJobProgress(jobId, "completed", 0, 0),
			);
			await publishProgress({ phase: "completed", current: 0, total: 0 });
			return { processed: 0, successful: 0 };
		}

		await step.run("update-embedding-total", () =>
			updateJobProgress(jobId, "embedding", 0, photoData.length),
		);
		await publishProgress({
			phase: "embedding",
			current: 0,
			total: photoData.length,
		});

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

					const started = performance.now();
					const embeddings = await nativeExecutor.run(
						"batchGenerateClipEmbeddings",
						thumbnailPaths,
					);
					const inferenceFinished = performance.now();

					const result = saveEmbeddingBatch(
						db,
						batch.map((photo) => photo.id),
						embeddings,
					);
					console.log(
						`Embedding batch ${batchIndex}: native queue + image load/model/inference ${Math.round(inferenceFinished - started)}ms, database save ${Math.round(performance.now() - inferenceFinished)}ms for ${batch.length} photos`,
					);
					return result;
				},
			);

			processedCount += batchResult.processed;
			successCount += batchResult.successful;

			await step.run(`mark-batch-${batchIndex}-embedded`, () =>
				updateJobProgress(jobId, "embedding", processedCount, photoData.length),
			);
			await publishProgress({
				phase: "embedding",
				current: processedCount,
				total: photoData.length,
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

		const finalPhase = successCount === 0 ? "failed" : "completed";
		if (finalPhase === "failed") {
			await step.run("mark-embedding-failed", () =>
				failJob(jobId, new Error("No photo embeddings could be generated")),
			);
		} else {
			await step.run("mark-embedding-completed", () =>
				updateJobProgress(jobId, "completed", processedCount, processedCount),
			);
		}
		await publishProgress({
			phase: finalPhase,
			current: processedCount,
			total: processedCount,
		});

		return { processed: photoData.length, successful: successCount };
	},
);
