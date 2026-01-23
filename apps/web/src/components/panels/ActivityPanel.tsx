import type { TaskProgress, TaskType } from "@photobrain/utils";
import {
	Brain,
	Camera,
	CheckCircle,
	Hash,
	Loader2,
	XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface TaskItemProps {
	taskType: TaskType;
	progress: TaskProgress;
}

function getTaskIcon(taskType: TaskType) {
	switch (taskType) {
		case "scan":
			return Camera;
		case "phash":
			return Hash;
		case "embedding":
			return Brain;
	}
}

function getTaskLabel(taskType: TaskType) {
	switch (taskType) {
		case "scan":
			return "Scanning Photos";
		case "phash":
			return "Generating Hashes";
		case "embedding":
			return "CLIP Embeddings";
	}
}

function TaskItem({ taskType, progress }: TaskItemProps) {
	const Icon = getTaskIcon(taskType);
	const label = getTaskLabel(taskType);
	const isActive = progress.total > 0 && progress.current < progress.total;
	const isComplete = progress.total > 0 && progress.current >= progress.total;
	const percentage =
		progress.total > 0
			? Math.round((progress.current / progress.total) * 100)
			: 0;

	const failedCount = progress.items.filter(
		(item) => item.status === "failed",
	).length;

	if (progress.total === 0) {
		return null;
	}

	return (
		<div className="px-3 py-2 border-b border-border/50 last:border-b-0">
			<div className="flex items-center gap-2 mb-1">
				{isActive ? (
					<Loader2 className="h-4 w-4 animate-spin text-primary" />
				) : isComplete ? (
					<CheckCircle className="h-4 w-4 text-green-500" />
				) : (
					<Icon className="h-4 w-4 text-muted-foreground" />
				)}
				<span className="text-sm font-medium flex-1">{label}</span>
				<span className="text-xs text-muted-foreground">
					{progress.current}/{progress.total}
				</span>
			</div>

			{/* Progress bar */}
			<div className="h-1.5 bg-muted rounded-full overflow-hidden">
				<div
					className={cn(
						"h-full transition-all duration-300",
						isComplete ? "bg-green-500" : "bg-primary",
					)}
					style={{ width: `${percentage}%` }}
				/>
			</div>

			{/* Failed items indicator */}
			{failedCount > 0 && (
				<div className="flex items-center gap-1 mt-1 text-destructive">
					<XCircle className="h-3 w-3" />
					<span className="text-xs">{failedCount} failed</span>
				</div>
			)}
		</div>
	);
}

interface ActivityPanelProps {
	scanProgress: TaskProgress;
	phashProgress: TaskProgress;
	embeddingProgress: TaskProgress;
	hasActiveJobs: boolean;
}

export function ActivityPanel({
	scanProgress,
	phashProgress,
	embeddingProgress,
	hasActiveJobs,
}: ActivityPanelProps) {
	// Debug logging
	console.log("[ActivityPanel] Progress:", {
		scan: { current: scanProgress.current, total: scanProgress.total },
		phash: { current: phashProgress.current, total: phashProgress.total },
		embedding: {
			current: embeddingProgress.current,
			total: embeddingProgress.total,
		},
		hasActiveJobs,
	});

	const hasAnyTasks =
		scanProgress.total > 0 ||
		phashProgress.total > 0 ||
		embeddingProgress.total > 0;

	return (
		<div className="border-t border-border bg-panel">
			<div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
				{hasActiveJobs ? (
					<Loader2 className="h-4 w-4 animate-spin text-primary" />
				) : (
					<CheckCircle className="h-4 w-4 text-muted-foreground" />
				)}
				<span className="text-sm font-semibold">Activity</span>
			</div>

			{hasAnyTasks ? (
				<div>
					<TaskItem taskType="scan" progress={scanProgress} />
					<TaskItem taskType="phash" progress={phashProgress} />
					<TaskItem taskType="embedding" progress={embeddingProgress} />
				</div>
			) : (
				<div className="px-3 py-4 text-center text-sm text-muted-foreground">
					No active tasks
				</div>
			)}
		</div>
	);
}

export default ActivityPanel;
