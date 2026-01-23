import { eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "@/config";
import { photos as photosTable } from "@/db/schema";
import {
	addScanJob,
	embeddingQueue,
	embeddingQueueEvents,
	getJobCounts,
	phashQueue,
	phashQueueEvents,
	scanQueue,
	scanQueueEvents,
} from "@/queue";
import { searchPhotosByText } from "@/services/vector-search";
import { publicProcedure, router } from "./trpc";

// Task types for subscriptions
const TaskTypeSchema = z.enum(["scan", "phash", "embedding"]);
type TaskType = z.infer<typeof TaskTypeSchema>;

export const appRouter = router({
	// Get all photos with EXIF data
	photos: publicProcedure
		.input(
			z
				.object({
					filterRaw: z.enum(["all", "raw", "standard"]).default("all"),
				})
				.optional(),
		)
		.query(async ({ ctx, input }) => {
			const filter = input?.filterRaw ?? "all";

			const photosList = await ctx.db.query.photos.findMany({
				where:
					filter === "raw"
						? eq(photosTable.isRaw, true)
						: filter === "standard"
							? eq(photosTable.isRaw, false)
							: undefined,
				with: {
					exif: true,
				},
			});

			const rawCount = photosList.filter((p) => p.isRaw).length;

			return {
				photos: photosList,
				total: photosList.length,
				rawCount,
			};
		}),

	// Get single photo by ID with EXIF data
	photo: publicProcedure
		.input(z.object({ id: z.number() }))
		.query(async ({ ctx, input }) => {
			const photo = await ctx.db.query.photos.findFirst({
				where: (photos, { eq }) => eq(photos.id, input.id),
				with: {
					exif: true,
				},
			});

			if (!photo) {
				throw new Error("Photo not found");
			}

			return photo;
		}),

	// Search photos using semantic search
	searchPhotos: publicProcedure
		.input(
			z.object({
				query: z.string().min(1),
				limit: z.number().min(1).max(100).default(20),
			}),
		)
		.query(async ({ input }) => {
			const photos = await searchPhotosByText(input.query, input.limit);
			return {
				photos,
				total: photos.length,
				query: input.query,
			};
		}),

	// Start a scan job (BullMQ-based async scan)
	scan: publicProcedure.mutation(async () => {
		try {
			const job = await addScanJob({
				directory: config.PHOTO_DIRECTORY,
				thumbnailsDir: config.THUMBNAILS_DIRECTORY,
			});
			return { success: true, jobId: job.id };
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.error("Failed to start scan job:", message);
			return { success: false, error: message };
		}
	}),

	// Get job counts for all queues
	jobCounts: publicProcedure.query(async () => {
		try {
			const counts = await getJobCounts();
			return { counts };
		} catch (error) {
			console.error("Failed to get job counts:", error);
			return {
				counts: {
					scan: { active: 0, waiting: 0, completed: 0, failed: 0 },
					phash: { active: 0, waiting: 0, completed: 0, failed: 0 },
					embedding: { active: 0, waiting: 0, completed: 0, failed: 0 },
				},
			};
		}
	}),

	// Subscription for task progress updates (SSE via BullMQ QueueEvents)
	onTaskProgress: publicProcedure
		.input(
			z
				.object({
					taskTypes: z.array(TaskTypeSchema).optional(),
				})
				.optional(),
		)
		.subscription(async function* (opts) {
			const { taskTypes } = opts.input ?? {};

			// Create event handlers for each queue
			const eventQueues: Array<{
				type: TaskType;
				events: typeof scanQueueEvents;
				queue: typeof scanQueue;
			}> = [];

			if (!taskTypes || taskTypes.includes("scan")) {
				eventQueues.push({
					type: "scan",
					events: scanQueueEvents,
					queue: scanQueue,
				});
			}
			if (!taskTypes || taskTypes.includes("phash")) {
				eventQueues.push({
					type: "phash",
					events: phashQueueEvents,
					queue: phashQueue,
				});
			}
			if (!taskTypes || taskTypes.includes("embedding")) {
				eventQueues.push({
					type: "embedding",
					events: embeddingQueueEvents,
					queue: embeddingQueue,
				});
			}

			// Set up event listeners with a shared event queue
			const eventBuffer: Array<{
				type: "progress" | "completed" | "failed" | "active";
				taskType: TaskType;
				jobId: string;
				data?: unknown;
				returnvalue?: unknown;
				failedReason?: string;
			}> = [];

			const cleanupFns: Array<() => void> = [];

			for (const { type, events } of eventQueues) {
				const onProgress = ({
					jobId,
					data,
				}: {
					jobId: string;
					data: unknown;
				}) => {
					eventBuffer.push({ type: "progress", taskType: type, jobId, data });
				};
				const onCompleted = ({
					jobId,
					returnvalue,
				}: {
					jobId: string;
					returnvalue: unknown;
				}) => {
					eventBuffer.push({
						type: "completed",
						taskType: type,
						jobId,
						returnvalue,
					});
				};
				const onFailed = ({
					jobId,
					failedReason,
				}: {
					jobId: string;
					failedReason: string;
				}) => {
					eventBuffer.push({
						type: "failed",
						taskType: type,
						jobId,
						failedReason,
					});
				};
				const onActive = ({ jobId }: { jobId: string }) => {
					eventBuffer.push({ type: "active", taskType: type, jobId });
				};

				events.on("progress", onProgress);
				events.on("completed", onCompleted);
				events.on("failed", onFailed);
				events.on("active", onActive);

				cleanupFns.push(() => {
					events.off("progress", onProgress);
					events.off("completed", onCompleted);
					events.off("failed", onFailed);
					events.off("active", onActive);
				});
			}

			try {
				// Poll for events and yield them
				while (true) {
					// Drain the event buffer
					while (eventBuffer.length > 0) {
						const event = eventBuffer.shift()!;
						yield {
							eventType: event.type,
							taskType: event.taskType,
							jobId: event.jobId,
							data: event.data,
							returnvalue: event.returnvalue,
							failedReason: event.failedReason,
						};
					}

					// Small delay before checking again
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			} finally {
				// Cleanup event listeners
				for (const cleanup of cleanupFns) {
					cleanup();
				}
			}
		}),
});

// Export type for use in clients
export type AppRouter = typeof appRouter;
