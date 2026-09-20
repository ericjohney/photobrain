import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
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
			return "Waiting for the sync service";
		case "discovering":
			return "Looking for new and changed photos";
		case "processing":
			return "Preparing previews and photo details";
		case "scan-complete":
			return "Photos are ready. Search is next.";
		case "embedding":
			return "Making your library searchable by meaning";
		case "completed":
			return "Every photo and search result is ready";
		case "failed":
			return "Sync stopped before your library was ready";
		default:
			return "Restoring your latest sync";
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
					{ backgroundColor: color, width: `${progress}%` },
				]}
			/>
		</View>
	);
}

function getPhaseLabel(phase: string | null): string {
	switch (phase) {
		case "discovering":
			return "Finding Photos";
		case "processing":
			return "Preparing Library";
		case "embedding":
			return "Building Search";
		case "scan-complete":
			return "Starting Search";
		case "completed":
			return "Library Up to Date";
		case "queued":
			return "Waiting to Sync";
		case "failed":
			return "Sync Failed";
		default:
			return "Checking Sync";
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
					? colors.success
					: active
						? colors.primary
						: colors.muted;

				return (
					<View
						key={label}
						style={[styles.pipelineStageTrack, { backgroundColor: color }]}
					/>
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
		? "Progress Unavailable"
		: getPhaseLabel(progress.phase);
	const icon = isFailed
		? "alert-circle"
		: isCompleted
			? "checkmark"
			: getPhaseIcon(progress.phase);
	const isEmbedding = progress.phase === "embedding";
	const detail = getPhaseDetail(progress.phase);
	const statusColor = isFailed
		? colors.destructive
		: isCompleted || isEmbedding
			? colors.success
			: colors.primary;

	return (
		<GlassSurface
			testID="sync-status-card"
			style={styles.container}
			fallbackStyle={{ backgroundColor: colors.card }}
			glassEffectStyle="clear"
		>
			<View style={styles.headerRow}>
				<View
					style={[
						styles.iconBadge,
						{ backgroundColor: colors.background, borderColor: statusColor },
					]}
				>
					<Ionicons name={icon} size={20} color={statusColor} />
				</View>
				<View style={styles.titleBlock}>
					<Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>
						LIBRARY SYNC
					</Text>
					<Text style={[styles.progressText, { color: colors.foreground }]}>
						{label}
					</Text>
				</View>
				{progress.total > 0 && (
					<View
						style={[styles.percentageBadge, { backgroundColor: colors.muted }]}
					>
						<Text style={[styles.percentageText, { color: statusColor }]}>
							{progress.percentage}%
						</Text>
					</View>
				)}
			</View>
			<Text style={[styles.phaseDetail, { color: colors.mutedForeground }]}>
				{detail}
			</Text>
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
			<PipelineStages phase={progress.phase} isFailed={isFailed} />
			{progress.total > 0 && (
				<>
					<View style={styles.progressInfo}>
						<Text
							style={[styles.progressCount, { color: colors.mutedForeground }]}
						>
							{progress.current.toLocaleString()} of{" "}
							{progress.total.toLocaleString()} photos
						</Text>
					</View>
					<ProgressBar
						current={progress.current}
						total={progress.total}
						color={statusColor}
					/>
				</>
			)}
		</GlassSurface>
	);
}

const styles = StyleSheet.create({
	container: {
		width: "100%",
		maxWidth: 520,
		alignSelf: "center",
		padding: 12,
		borderRadius: 22,
		borderCurve: "continuous",
		overflow: "hidden",
		gap: 6,
		shadowColor: "#000000",
		shadowOffset: { width: 0, height: 8 },
		shadowOpacity: 0.16,
		shadowRadius: 20,
		elevation: 8,
	},
	headerRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
	},
	iconBadge: {
		width: 36,
		height: 36,
		borderRadius: 18,
		borderWidth: 1,
		alignItems: "center",
		justifyContent: "center",
	},
	titleBlock: {
		flex: 1,
		minWidth: 0,
		gap: 1,
	},
	eyebrow: {
		fontSize: 10,
		fontWeight: "700",
		letterSpacing: 0.9,
	},
	progressText: {
		fontSize: 17,
		fontWeight: "700",
		letterSpacing: -0.2,
	},
	percentageBadge: {
		minWidth: 52,
		paddingHorizontal: 10,
		paddingVertical: 6,
		borderRadius: 999,
		alignItems: "center",
	},
	percentageText: {
		fontSize: 13,
		fontWeight: "700",
		fontVariant: ["tabular-nums"],
	},
	phaseDetail: {
		fontSize: 13,
		lineHeight: 17,
	},
	pipelineStages: {
		flexDirection: "row",
		gap: 6,
		marginTop: 2,
	},
	pipelineStageTrack: {
		flex: 1,
		height: 4,
		borderRadius: 2,
	},
	progressInfo: {
		flexDirection: "row",
		justifyContent: "space-between",
	},
	progressCount: {
		fontSize: 11,
		fontWeight: "500",
		fontVariant: ["tabular-nums"],
	},
	failureText: {
		fontSize: 12,
		lineHeight: 16,
		fontWeight: "500",
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
