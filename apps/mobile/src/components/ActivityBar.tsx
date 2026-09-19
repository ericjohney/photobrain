import { Ionicons } from "@expo/vector-icons";
import { Platform, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { useColors } from "@/theme";
import GlassSurface from "./GlassSurface";

export interface ProgressData {
	phase: string | null;
	current: number;
	total: number;
	percentage: number;
}

interface ActivityBarProps {
	progress: ProgressData;
	isActive: boolean;
	isCompleted: boolean;
	isFailed?: boolean;
	failureMessage?: string | null;
	error?: string | null;
}

const PIPELINE_STAGES = ["Discover", "Prepare", "Search"] as const;

function getPhaseDetail(phase: string | null): string {
	switch (phase) {
		case "queued":
			return "Waiting for the background service";
		case "discovering":
			return "Finding supported photos in your library";
		case "processing":
			return "Reading metadata and creating thumbnails";
		case "scan-complete":
			return "Photo scan finished; search indexing starts next";
		case "embedding":
			return "Generating CLIP embeddings for semantic search";
		case "completed":
			return "Photos and semantic search are ready";
		case "failed":
			return "The library update stopped before it could finish";
		default:
			return "Restoring the latest durable scan state";
	}
}

function getActiveStage(phase: string | null): number {
	switch (phase) {
		case "discovering":
			return 0;
		case "processing":
			return 1;
		case "scan-complete":
		case "embedding":
			return 2;
		case "completed":
			return PIPELINE_STAGES.length;
		default:
			return -1;
	}
}

function ProgressBar({
	current,
	total,
	color,
}: {
	current: number;
	total: number;
	color: string;
}) {
	const colors = useColors();
	const progress =
		total > 0 ? Math.min(100, Math.max(0, (current / total) * 100)) : 0;

	return (
		<View
			accessible
			accessibilityRole="progressbar"
			accessibilityValue={{ min: 0, max: total, now: current }}
			style={[styles.progressBarContainer, { backgroundColor: colors.muted }]}
		>
			<View
				style={[
					styles.progressBar,
					{
						backgroundColor: color,
						width: `${progress}%`,
					},
					Platform.OS === "web"
						? ({ transition: "width 0.3s ease-out" } as unknown as ViewStyle)
						: undefined,
				]}
			/>
		</View>
	);
}

function getPhaseLabel(phase: string | null): string {
	switch (phase) {
		case "discovering":
			return "Discovering Photos";
		case "processing":
			return "Preparing Photos";
		case "embedding":
			return "Building Search Index";
		case "scan-complete":
			return "Starting Search Index";
		case "completed":
			return "Library Up to Date";
		case "queued":
			return "Scan Queued";
		case "failed":
			return "Scan Failed";
		default:
			return "Checking scan status";
	}
}

function getPhaseIcon(phase: string | null): keyof typeof Ionicons.glyphMap {
	switch (phase) {
		case "discovering":
			return "scan-outline";
		case "processing":
			return "images-outline";
		case "scan-complete":
		case "embedding":
			return "sparkles-outline";
		default:
			return "hourglass-outline";
	}
}

function PipelineStages({
	phase,
	isFailed,
}: {
	phase: string | null;
	isFailed: boolean;
}) {
	const colors = useColors();
	if (!phase || isFailed) return null;

	const activeStage = getActiveStage(phase);
	const isCompleted = phase === "completed";
	const accessibilityStage =
		activeStage < 0
			? "waiting to start"
			: isCompleted
				? "all 3 stages complete"
				: `stage ${activeStage + 1} of 3`;

	return (
		<View
			accessible
			accessibilityLabel={`Scan pipeline: ${accessibilityStage}`}
			style={styles.pipelineStages}
		>
			{PIPELINE_STAGES.map((label, index) => {
				const complete = isCompleted || index < activeStage;
				const active = !isCompleted && index === activeStage;
				const color = complete
					? "#22c55e"
					: active
						? colors.primary
						: colors.muted;
				const labelColor =
					complete || active ? colors.foreground : colors.mutedForeground;

				return (
					<View key={label} style={styles.pipelineStage}>
						<View
							style={[styles.pipelineStageTrack, { backgroundColor: color }]}
						/>
						<Text style={[styles.pipelineStageLabel, { color: labelColor }]}>
							{label}
						</Text>
					</View>
				);
			})}
		</View>
	);
}

export default function ActivityBar({
	progress,
	isActive,
	isCompleted,
	isFailed = false,
	failureMessage,
	error,
}: ActivityBarProps) {
	const colors = useColors();

	if (!isActive && !isCompleted && !isFailed) {
		return null;
	}

	const isUnavailable =
		isActive && !isCompleted && !isFailed && !progress.phase && Boolean(error);
	const label = isUnavailable
		? "Progress unavailable"
		: getPhaseLabel(progress.phase);
	const icon = getPhaseIcon(progress.phase);
	const isEmbedding = progress.phase === "embedding";
	const detail = getPhaseDetail(progress.phase);

	return (
		<GlassSurface style={styles.container} glassEffectStyle="clear">
			<View style={styles.progressRow}>
				<View style={styles.progressLabel}>
					{isFailed ? (
						<Ionicons
							name="alert-circle"
							size={14}
							color={colors.destructive}
						/>
					) : isActive ? (
						<Ionicons name={icon} size={14} color={colors.primary} />
					) : isCompleted ? (
						<Ionicons name="checkmark-circle" size={14} color="#22c55e" />
					) : (
						<Ionicons name={icon} size={14} color={colors.mutedForeground} />
					)}
					<Text style={[styles.progressText, { color: colors.foreground }]}>
						{label}
					</Text>
				</View>
				<Text style={[styles.phaseDetail, { color: colors.mutedForeground }]}>
					{detail}
				</Text>
				<PipelineStages phase={progress.phase} isFailed={isFailed} />
				{isFailed && failureMessage && (
					<Text
						style={[styles.failureText, { color: colors.destructive }]}
						numberOfLines={2}
					>
						{failureMessage}
					</Text>
				)}
				{isUnavailable && (
					<Text style={[styles.failureText, { color: colors.mutedForeground }]}>
						{error}
					</Text>
				)}
				{progress.total > 0 && (
					<View style={styles.progressInfo}>
						<Text
							style={[styles.progressCount, { color: colors.mutedForeground }]}
						>
							{progress.current.toLocaleString()} of{" "}
							{progress.total.toLocaleString()}
						</Text>
						<Text
							style={[styles.progressCount, { color: colors.mutedForeground }]}
						>
							{progress.percentage}%
						</Text>
					</View>
				)}
				{progress.total > 0 && (
					<ProgressBar
						current={progress.current}
						total={progress.total}
						color={
							isCompleted ? "#22c55e" : isEmbedding ? "#22c55e" : colors.primary
						}
					/>
				)}
			</View>
		</GlassSurface>
	);
}

const styles = StyleSheet.create({
	container: {
		marginHorizontal: 12,
		marginTop: 8,
		paddingHorizontal: 16,
		paddingVertical: 10,
		borderRadius: 18,
		borderCurve: "continuous",
		gap: 8,
	},
	progressRow: {
		gap: 4,
	},
	progressLabel: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
	},
	progressText: {
		fontSize: 13,
		fontWeight: "500",
	},
	phaseDetail: {
		fontSize: 12,
		lineHeight: 16,
	},
	pipelineStages: {
		flexDirection: "row",
		gap: 6,
		marginTop: 4,
	},
	pipelineStage: {
		flex: 1,
		gap: 3,
	},
	pipelineStageTrack: {
		height: 3,
		borderRadius: 2,
	},
	pipelineStageLabel: {
		fontSize: 10,
		fontWeight: "500",
	},
	progressInfo: {
		flexDirection: "row",
		justifyContent: "space-between",
		marginTop: 2,
	},
	progressCount: {
		fontSize: 12,
	},
	failureText: {
		fontSize: 12,
		lineHeight: 16,
	},
	progressBarContainer: {
		height: 4,
		borderRadius: 2,
		overflow: "hidden",
	},
	progressBar: {
		height: "100%",
		borderRadius: 2,
	},
});
