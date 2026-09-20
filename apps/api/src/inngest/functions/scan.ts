import { eq } from "drizzle-orm";
import { db } from "../../db";
import { scanJobs, scanManifests } from "../../db/schema";
import { nativeExecutor } from "../../services/native-executor";
import { createScanPlan } from "../../services/scan-planner";
import {
	clearScanWork,
	commitScanResult,
	getScanWorkProgress,
	initializeScanWork,
	pendingScanWork,
	scanEmbeddingPhotoIds,
} from "../../services/scan-work";
import { inngest } from "../client";
import { failJob, updateJobProgress } from "../progress";

function scanActive(jobId: string) {
	const job = db.select().from(scanJobs).where(eq(scanJobs.id, jobId)).get();
	return !!job && job.status !== "completed" && job.status !== "failed";
}

export const scanPhotosFunction = inngest.createFunction(
	{
		// Drain old scan runs before deploying this new checkpoint graph.
		id: "scan-photos-v5",
		concurrency: { limit: 1 },
		onFailure: async ({ event, error, publish, step }) => {
			const jobId = event.data.event.data.jobId;
			const failedJob = await step.run(
				"persist-terminal-failure-v5",
				async () => {
					try {
						await nativeExecutor.cancelPhotos(jobId);
					} catch (cancelError) {
						// A dead/overloaded executor must not leave an exhausted job running.
						console.error(
							`Failed to cancel native work for ${jobId}:`,
							cancelError,
						);
					}
					const failed = await failJob(jobId, error);
					clearScanWork(db, jobId);
					return failed;
				},
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
		const { directory, thumbnailsDir, jobId, force = false } = event.data;
		const publishProgress = (data: {
			phase: string;
			current: number;
			total: number;
		}) => publish({ channel: `job:${jobId}`, topic: "progress", data });

		const started = await step.run("claim-scan-job-v5", async () => {
			const job = db
				.select()
				.from(scanJobs)
				.where(eq(scanJobs.id, jobId))
				.get();
			if (!scanActive(jobId)) return false;
			// A lost claim checkpoint must not reset already committed progress.
			if (job?.phase === "queued") {
				await updateJobProgress(jobId, "discovering", 0, 0);
				await publishProgress({ phase: "discovering", current: 0, total: 0 });
			}
			return true;
		});
		if (!started) return { processed: 0, successful: 0 };

		let progress = await step.run("initialize-scan-work-v5", async () => {
			if (!scanActive(jobId)) return null;
			// The durable header freezes discovery even when there are zero files.
			if (
				db
					.select()
					.from(scanManifests)
					.where(eq(scanManifests.jobId, jobId))
					.get()
			) {
				return getScanWorkProgress(db, jobId);
			}
			const discovery = await nativeExecutor.run("discoverPhotos", directory);
			if (!scanActive(jobId)) return null;
			const plan = await createScanPlan(
				db,
				discovery,
				directory,
				thumbnailsDir,
				force,
			);
			if (!scanActive(jobId)) return null;
			return initializeScanWork(db, jobId, plan);
		});
		if (!progress) return { processed: 0, successful: 0 };

		const processing = await step.run("mark-processing-v5", async () => {
			if (!scanActive(jobId)) return false;
			const durable = getScanWorkProgress(db, jobId);
			await updateJobProgress(
				jobId,
				"processing",
				durable.processed,
				durable.total,
			);
			await publishProgress({
				phase: "processing",
				current: durable.processed,
				total: durable.total,
			});
			return true;
		});
		if (!processing)
			return { processed: progress.processed, successful: progress.successful };

		for (let window = 0; progress.pending > 0; window++) {
			const checkpoint = await step.run(
				`consume-photo-results-v5-${window}`,
				async () => {
					if (!scanActive(jobId)) {
						await nativeExecutor.cancelPhotos(jobId);
						const durable = getScanWorkProgress(db, jobId);
						clearScanWork(db, jobId);
						return { ...durable, active: false };
					}
					// Publish the first completion immediately. While it is in flight retain
					// only the latest progress, never a promise or message per photo. Realtime
					// middleware publishes directly inside this step (no nested checkpoints).
					let latest:
						| { phase: string; current: number; total: number }
						| undefined;
					let publishing: Promise<void> | undefined;
					let publishedCurrent = -1;
					let publicationFailed = false;
					let publicationError: unknown;
					const publishLatest = () => {
						if (publishing || publicationFailed || !latest) return;
						if (!scanActive(jobId)) {
							latest = undefined;
							return;
						}
						const data = latest;
						latest = undefined;
						publishing = publishProgress(data)
							.then(() => {
								publishedCurrent = data.current;
							})
							.catch((error: unknown) => {
								publicationFailed = true;
								publicationError = error;
							})
							.finally(() => {
								publishing = undefined;
								publishLatest();
							});
					};
					const stopped = new Error("Scan became terminal");
					try {
						await nativeExecutor.consumePhotos(
							jobId,
							thumbnailsDir,
							() => pendingScanWork(db, jobId),
							async (id, result, thumbnailKey) => {
								const committed = await commitScanResult(
									db,
									jobId,
									id,
									result,
									thumbnailKey,
								);
								if (!committed.active) throw stopped;
								if (committed.committed) {
									latest = {
										phase: "processing",
										current: committed.processed,
										total: committed.total,
									};
									publishLatest();
								}
							},
							20,
						);
						while (publishing) await publishing;
						if (publicationFailed) throw publicationError;
						const durable = getScanWorkProgress(db, jobId);
						// A replay may have no pending inputs after losing its checkpoint;
						// republish the durable count if this window did not publish it.
						if (scanActive(jobId) && durable.processed !== publishedCurrent) {
							await publishProgress({
								phase: "processing",
								current: durable.processed,
								total: durable.total,
							});
						}
						return { ...durable, active: scanActive(jobId) };
					} catch (error) {
						await nativeExecutor.cancelPhotos(jobId);
						while (publishing) await publishing;
						if (error === stopped) {
							const durable = getScanWorkProgress(db, jobId);
							clearScanWork(db, jobId);
							return { ...durable, active: false };
						}
						throw error;
					}
				},
			);
			progress = checkpoint;
			if (!checkpoint.active)
				return {
					processed: progress.processed,
					successful: progress.successful,
				};
		}

		const result = {
			processed: progress.processed,
			successful: progress.successful,
		};
		if (result.processed > 0 && result.successful === 0) {
			await step.run("mark-scan-failed-v5", async () => {
				await nativeExecutor.cancelPhotos(jobId);
				const failed = await failJob(
					jobId,
					new Error("No photos could be processed"),
				);
				clearScanWork(db, jobId);
				if (failed) {
					try {
						await publishProgress({ phase: "failed", ...failed });
					} catch (error) {
						console.error(`Failed to publish failure for ${jobId}:`, error);
					}
				}
			});
			return result;
		}

		// Checkpoint IDs before terminal progress or dispatch; retain receipts until
		// the event checkpoint succeeds, including retries after a lost response.
		const photoIds = await step.run("completed-scan-photo-ids-v5", () =>
			scanEmbeddingPhotoIds(db, jobId),
		);
		const phase = photoIds.length > 0 ? "scan-complete" : "completed";
		const total = progress.total;
		const finished = await step.run("mark-scan-finished-v5", async () => {
			if (await updateJobProgress(jobId, phase, result.processed, total))
				return true;
			// Empty and fully indexed unchanged scans become terminal here. A lost
			// checkpoint must still allow publication without reopening the job.
			const job = db
				.select()
				.from(scanJobs)
				.where(eq(scanJobs.id, jobId))
				.get();
			return (
				phase === "completed" &&
				job?.status === "completed" &&
				job.phase === phase &&
				job.current === result.processed &&
				job.total === total
			);
		});
		if (finished) {
			await step.run("publish-scan-finished-v5", () =>
				publishProgress({ phase, current: result.processed, total }),
			);
			if (photoIds.length > 0) {
				await step.sendEvent("trigger-embeddings-v5", {
					name: "photos/embeddings.requested",
					data: { photoIds, thumbnailsDir, jobId },
				});
			}
		}
		// No parent progress writes after dispatch: the child may already be done.
		await step.run("clear-scan-work-v5", async () => {
			await nativeExecutor.cancelPhotos(jobId);
			clearScanWork(db, jobId);
		});
		return result;
	},
);
