import {
	createEmptyProgress,
	TASK_TYPES,
	type TaskProgress,
	type TaskType,
} from "@photobrain/utils";
import { useCallback, useState } from "react";
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
	const [progress, setProgress] =
		useState<TaskProgressState>(createInitialState);
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
			console.log(
				"[TaskProgress] Event:",
				event.eventType,
				event.taskType,
				event.jobId,
			);

			const data = event.data as ProgressData | undefined;

			setProgress((prev) => {
				const newProgress = { ...prev };
				const taskProgress = { ...prev[event.taskType] };

				switch (event.eventType) {
					case "active":
						// Job started
						break;

					case "progress":
						if (event.taskType === "scan" && data) {
							taskProgress.current = data.current ?? taskProgress.current;
							taskProgress.total = data.total ?? taskProgress.total;

							// Set embedding total from scan total
							if (data.total && data.total > 0) {
								newProgress.embedding = {
									...newProgress.embedding,
									total: data.total,
								};
							}

							// Update cache with new photo
							if (data.phase === "processing" && data.photo) {
								const photo = data.photo;
								utils.photos.setData(undefined, (oldData) => {
									if (!oldData) return oldData;
									if (
										oldData.photos.some(
											(p: { id: number }) => p.id === photo.id,
										)
									) {
										return oldData;
									}
									return {
										...oldData,
										photos: [...oldData.photos, photo],
										total: oldData.total + 1,
									};
								});
							}
						} else if (event.taskType === "embedding" && data) {
							taskProgress.current = data.current ?? taskProgress.current;
							taskProgress.total = data.total ?? taskProgress.total;
						}
						break;

					case "completed":
						if (event.taskType === "scan") {
							utils.photos.invalidate();
						}
						break;

					case "failed":
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
		},
	);

	// Reset progress state
	const resetProgress = useCallback(() => {
		setProgress(createInitialState());
	}, []);

	// Compute derived state
	const scanProgress = progress.scan;
	const embeddingProgress = progress.embedding;

	const hasActiveJobs =
		(scanProgress.total > 0 && scanProgress.current < scanProgress.total) ||
		(embeddingProgress.total > 0 &&
			embeddingProgress.current < embeddingProgress.total);

	const totalProgress = {
		current: scanProgress.current + embeddingProgress.current,
		total: scanProgress.total + embeddingProgress.total,
	};

	return {
		progress,
		scanProgress,
		embeddingProgress,
		hasActiveJobs,
		totalProgress,
		resetProgress,
	};
}
