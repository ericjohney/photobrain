import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useColors } from "@/theme";

interface ProgressData {
	phase: string | null;
	current: number;
	total: number;
	percentage: number;
}

interface ActivityBarProps {
	progress: ProgressData;
	isActive: boolean;
	isCompleted: boolean;
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
						// CSS transition for smooth animation on web
						...(Platform.OS === "web" && {
							transition: "width 0.3s ease-out",
						}),
					} as any,
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
			return "Scan Complete";
		case "completed":
			return "Complete";
		default:
			return "Processing";
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
}: ActivityBarProps) {
	const colors = useColors();

	if (!isActive && !isCompleted) {
		return null;
	}

	const label = getPhaseLabel(progress.phase);
	const icon = getPhaseIcon(progress.phase);
	const isEmbedding = progress.phase === "embedding";

	return (
		<View style={[styles.container, { backgroundColor: colors.toolbar }]}>
			<View style={styles.progressRow}>
				<View style={styles.progressLabel}>
					{isActive ? (
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
						color={isCompleted ? "#22c55e" : isEmbedding ? "#22c55e" : colors.primary}
					/>
				)}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		paddingHorizontal: 16,
		paddingVertical: 8,
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
