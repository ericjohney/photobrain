import { useState, useCallback } from "react";
import {
	type TaskType,
	type TaskProgress,
	createEmptyProgress,
	TASK_TYPES,
} from "@photobrain/utils";
import { trpc } from "@/lib/trpc";

export type TaskProgressState = Record<TaskType, TaskProgress>;

// Photo data shape from worker
interface PhotoData {
	id: number;
	path: string;
	name: string;
	size: number;
	createdAt: string | Date;
	modifiedAt: string | Date;
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

// BullMQ event progress data shape
interface ProgressData {
	phase?: string;
	current?: number;
	total?: number;
	photo?: PhotoData;
	photoId?: number;
	status?: string;
}

function createInitialState(): TaskProgressState {
	return Object.fromEntries(
		TASK_TYPES.map((type) => [type, createEmptyProgress(type)]),
	) as TaskProgressState;
}

export function useTaskProgress(taskTypes?: TaskType[]) {
	const [progress, setProgress] = useState<TaskProgressState>(createInitialState);
	const utils = trpc.useUtils();

	// Handle incoming BullMQ events
	const handleEvent = useCallback(
		(event: {
			eventType: "progress" | "completed" | "failed" | "active";
			taskType: TaskType;
			jobId: string;
			data: unknown;
			returnvalue: unknown;
			failedReason: string | undefined;
		}) => {
			console.log("[TaskProgress] Event:", event.eventType, event.taskType, event.jobId, event.data);

			// Cast data to ProgressData
			const data = event.data as ProgressData | undefined;

			setProgress((prev) => {
				const newProgress = { ...prev };
				const taskProgress = { ...prev[event.taskType] };

				switch (event.eventType) {
					case "active":
						// Job started - for scan jobs, we'll get total from first progress
						break;

					case "progress":
						// Update progress based on task type
						if (event.taskType === "scan" && data) {
							taskProgress.current = data.current ?? taskProgress.current;
							taskProgress.total = data.total ?? taskProgress.total;

							// Set phash/embedding totals from scan total immediately
							if (data.total && data.total > 0) {
								newProgress.phash = { ...newProgress.phash, total: data.total };
								newProgress.embedding = { ...newProgress.embedding, total: data.total };
							}

							// Add photo directly to cache from event data (no fetch needed)
							if (data.phase === "processing" && data.photo) {
								const photo = data.photo;

								utils.photos.setData(undefined, (oldData) => {
									if (!oldData) return oldData;
									// Check if photo already exists
									if (oldData.photos.some((p) => p.id === photo.id)) {
										return oldData;
									}
									return {
										...oldData,
										photos: [...oldData.photos, photo],
										total: oldData.total + 1,
									};
								});
							}
						} else if (data?.photoId) {
							// Phash/embedding jobs report per-photo progress
							const photoId = data.photoId;
							const status = data.status === "failed" ? "failed" : "completed";

							// Add item if not already present
							if (!taskProgress.items.find((item) => item.id === photoId)) {
								taskProgress.items = [
									...taskProgress.items,
									{ id: photoId, status, error: undefined },
								];
								taskProgress.current = taskProgress.items.length;
							}
						}
						break;

					case "completed":
						// Mark job as complete
						if (event.taskType === "scan") {
							// Invalidate photos query to refresh the grid
							utils.photos.invalidate();
						}
						break;

					case "failed":
						// Record failure
						console.error(`Job ${event.jobId} failed:`, event.failedReason);
						break;
				}

				newProgress[event.taskType] = taskProgress;
				return newProgress;
			});
		},
		[utils],
	);

	// Subscribe to task progress
	trpc.onTaskProgress.useSubscription(
		{ taskTypes },
		{
			onData: handleEvent,
			onError: (error) => {
				console.error("Task progress subscription error:", error);
			},
			onStarted: () => {
				console.log("[TaskProgress] Subscription started");
			},
		},
	);

	// Reset progress state
	const resetProgress = useCallback(() => {
		setProgress(createInitialState());
	}, []);

	// Compute derived state
	const scanProgress = progress.scan;
	const phashProgress = progress.phash;
	const embeddingProgress = progress.embedding;

	const hasActiveJobs =
		(scanProgress.total > 0 && scanProgress.current < scanProgress.total) ||
		(phashProgress.total > 0 && phashProgress.current < phashProgress.total) ||
		(embeddingProgress.total > 0 && embeddingProgress.current < embeddingProgress.total);

	const totalProgress = {
		current: scanProgress.current + phashProgress.current + embeddingProgress.current,
		total: scanProgress.total + phashProgress.total + embeddingProgress.total,
	};

	return {
		progress,
		scanProgress,
		phashProgress,
		embeddingProgress,
		hasActiveJobs,
		totalProgress,
		resetProgress,
	};
}
