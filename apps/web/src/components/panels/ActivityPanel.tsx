import { Brain, Camera, CheckCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface ProgressData {
	phase: string | null;
	current: number;
	total: number;
	percentage: number;
}

function getPhaseIcon(phase: string | null) {
	switch (phase) {
		case "discovering":
		case "processing":
		case "scan-complete":
			return Camera;
		case "embedding":
			return Brain;
		default:
			return Camera;
	}
}

function getPhaseLabel(phase: string | null) {
	switch (phase) {
		case "discovering":
			return "Discovering Photos";
		case "processing":
			return "Processing Photos";
		case "scan-complete":
			return "Scan Complete";
		case "embedding":
			return "Generating Embeddings";
		case "completed":
			return "Complete";
		default:
			return "Processing";
	}
}

interface ActivityPanelProps {
	progress: ProgressData;
	isActive: boolean;
	isCompleted: boolean;
}

export function ActivityPanel({
	progress,
	isActive,
	isCompleted,
}: ActivityPanelProps) {
	const Icon = getPhaseIcon(progress.phase);
	const label = getPhaseLabel(progress.phase);
	const hasProgress = progress.total > 0 || progress.phase !== null;

	return (
		<div className="border-t border-border bg-panel">
			<div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
				{isActive ? (
					<Loader2 className="h-4 w-4 animate-spin text-primary" />
				) : (
					<CheckCircle className="h-4 w-4 text-muted-foreground" />
				)}
				<span className="text-sm font-semibold">Activity</span>
			</div>

			{hasProgress ? (
				<div className="px-3 py-2">
					<div className="flex items-center gap-2 mb-1">
						{isActive ? (
							<Loader2 className="h-4 w-4 animate-spin text-primary" />
						) : isCompleted ? (
							<CheckCircle className="h-4 w-4 text-green-500" />
						) : (
							<Icon className="h-4 w-4 text-muted-foreground" />
						)}
						<span className="text-sm font-medium flex-1">{label}</span>
						{progress.total > 0 && (
							<span className="text-xs text-muted-foreground">
								{progress.current}/{progress.total}
							</span>
						)}
					</div>

					{/* Progress bar */}
					{progress.total > 0 && (
						<div className="h-1.5 bg-muted rounded-full overflow-hidden">
							<div
								className={cn(
									"h-full transition-all duration-300",
									isCompleted ? "bg-green-500" : "bg-primary",
								)}
								style={{ width: `${progress.percentage}%` }}
							/>
						</div>
					)}
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
