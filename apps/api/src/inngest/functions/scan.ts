import { db } from "../../db";
import { saveScanBatch } from "../../services/import-persistence";
import { nativeExecutor } from "../../services/native-executor";
import { inngest } from "../client";
import { failJob, updateJobProgress } from "../progress";

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
			const result = await nativeExecutor.run("discoverPhotos", directory);
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
					const started = performance.now();
					const results = await nativeExecutor.run(
						"processPhotosBatch",
						batchFilePaths,
						batchRelativePaths,
						thumbnailsDir,
					);
					console.log(
						`Scan batch ${batchNum}: native queue + processing ${Math.round(performance.now() - started)}ms for ${results.length} photos`,
					);
					return results;
				},
			);

			const batchPhotoIds = await step.run(`save-batch-${batchNum}`, () => {
				const started = performance.now();
				const ids = saveScanBatch(db, batchResults);
				console.log(
					`Scan batch ${batchNum}: database save ${Math.round(performance.now() - started)}ms for ${ids.length} photos`,
				);
				return ids;
			});

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
