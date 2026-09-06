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
	const progress = total > 0 ? (current / total) * 100 : 0;

	return (
		<View
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
			return "Processing Photos";
		case "embedding":
			return "Generating Embeddings";
		case "scan-complete":
			return "Preparing Search";
		case "completed":
			return "Complete";
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
		case "processing":
		case "scan-complete":
			return "scan-outline";
		case "embedding":
			return "sparkles-outline";
		default:
			return "hourglass-outline";
	}
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
							{progress.current} / {progress.total}
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
	progressInfo: {
		flexDirection: "row",
		justifyContent: "flex-end",
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
