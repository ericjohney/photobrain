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
		id: "generate-embeddings-v3",
		concurrency: { limit: 1 },
		onFailure: async ({ event, error, publish, step }) => {
			const jobId = event.data.event.data.jobId;
			await step.run("persist-terminal-failure-v3", async () => {
				const failedJob = await failJob(jobId, error);
				if (!failedJob) return;
				try {
					await publish({
						channel: `job:${jobId}`,
						topic: "progress",
						data: { phase: "failed", ...failedJob },
					});
				} catch (publishError) {
					console.error(
						`Failed to publish failure for ${jobId}:`,
						publishError,
					);
				}
			});
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

		console.log(`Starting batch embedding for ${photoIds.length} photos`);
		const jobStarted = await step.run("claim-embedding-job-v3", () =>
			updateJobProgress(jobId, "embedding", 0, photoIds.length),
		);
		if (!jobStarted) {
			console.warn(`Skipping embeddings for missing or terminal job ${jobId}`);
			return { processed: 0, successful: 0 };
		}

		// Freeze the generation used for inference and the transactional save fence.
		const photoData = await step.run("get-photo-generations-v3", () =>
			db
				.select({
					id: photos.id,
					path: photos.path,
					thumbnailKey: photos.thumbnailKey,
					thumbnailRoot: photos.thumbnailRoot,
				})
				.from(photos)
				.where(inArray(photos.id, photoIds))
				.all(),
		);

		if (photoData.length === 0) {
			await step.run("mark-empty-embedding-completed-v3", async () => {
				if (await updateJobProgress(jobId, "completed", 0, 0)) {
					await publishProgress({ phase: "completed", current: 0, total: 0 });
				}
			});
			return { processed: 0, successful: 0 };
		}

		await step.run("update-embedding-total-v3", async () => {
			if (await updateJobProgress(jobId, "embedding", 0, photoData.length)) {
				await publishProgress({
					phase: "embedding",
					current: 0,
					total: photoData.length,
				});
			}
		});

		let processedCount = 0;
		let successCount = 0;

		for (let offset = 0; offset < photoData.length; offset += BATCH_SIZE) {
			const batch = photoData.slice(offset, offset + BATCH_SIZE);
			const batchIndex = offset / BATCH_SIZE;
			// Keep inference, persistence, progress and Realtime in one checkpoint.
			const batchResult = await step.run(
				`process-batch-v3-${batchIndex}`,
				async () => {
					const thumbnailPaths = batch.map((photo) =>
						path.join(
							photo.thumbnailRoot ?? thumbnailsDir,
							getThumbnailPath(photo.thumbnailKey ?? photo.path, "large"),
						),
					);
					const started = performance.now();
					const embeddings = await nativeExecutor.run(
						"batchGenerateClipEmbeddings",
						thumbnailPaths,
					);
					const inferenceFinished = performance.now();
					const result = saveEmbeddingBatch(db, batch, embeddings);
					console.log(
						`Embedding batch ${batchIndex}: native queue + image load/model/inference ${Math.round(inferenceFinished - started)}ms, database save ${Math.round(performance.now() - inferenceFinished)}ms for ${batch.length} photos`,
					);
					const current = processedCount + result.processed;
					if (
						await updateJobProgress(
							jobId,
							"embedding",
							current,
							photoData.length,
						)
					) {
						await publishProgress({
							phase: "embedding",
							current,
							total: photoData.length,
						});
					}
					return result;
				},
			);
			processedCount += batchResult.processed;
			successCount += batchResult.successful;
		}

		console.log(
			`Batch embedding complete: ${successCount}/${photoData.length} successful`,
		);
		await step.run("finish-embedding-job-v3", async () => {
			const phase = successCount === 0 ? "failed" : "completed";
			const updated =
				phase === "failed"
					? await failJob(
							jobId,
							new Error("No photo embeddings could be generated"),
						)
					: await updateJobProgress(
							jobId,
							"completed",
							processedCount,
							processedCount,
						);
			if (updated) {
				await publishProgress({
					phase,
					current: processedCount,
					total: processedCount,
				});
			}
		});

		return { processed: processedCount, successful: successCount };
	},
);
