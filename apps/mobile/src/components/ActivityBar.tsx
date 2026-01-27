import { Ionicons } from "@expo/vector-icons";
import type { TaskProgress } from "@photobrain/utils";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
	useAnimatedStyle,
	withSpring,
} from "react-native-reanimated";
import { useColors } from "@/theme";

interface ActivityBarProps {
	scanProgress: TaskProgress;
	embeddingProgress: TaskProgress;
	hasActiveJobs: boolean;
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

	const animatedStyle = useAnimatedStyle(() => ({
		width: withSpring(`${progress}%`, { damping: 15, stiffness: 100 }),
	}));

	return (
		<View
			style={[styles.progressBarContainer, { backgroundColor: colors.muted }]}
		>
			<Animated.View
				style={[styles.progressBar, { backgroundColor: color }, animatedStyle]}
			/>
		</View>
	);
}

export default function ActivityBar({
	scanProgress,
	embeddingProgress,
	hasActiveJobs,
}: ActivityBarProps) {
	const colors = useColors();

	if (!hasActiveJobs) {
		return null;
	}

	const isScanActive =
		scanProgress.total > 0 && scanProgress.current < scanProgress.total;
	const isEmbeddingActive =
		embeddingProgress.total > 0 &&
		embeddingProgress.current < embeddingProgress.total;

	return (
		<View style={[styles.container, { backgroundColor: colors.toolbar }]}>
			{isScanActive && (
				<View style={styles.progressRow}>
					<View style={styles.progressLabel}>
						<Ionicons
							name="scan-outline"
							size={14}
							color={colors.mutedForeground}
						/>
						<Text style={[styles.progressText, { color: colors.foreground }]}>
							Scanning
						</Text>
					</View>
					<View style={styles.progressInfo}>
						<Text
							style={[styles.progressCount, { color: colors.mutedForeground }]}
						>
							{scanProgress.current} / {scanProgress.total}
						</Text>
					</View>
					<ProgressBar
						current={scanProgress.current}
						total={scanProgress.total}
						color={colors.primary}
					/>
				</View>
			)}

			{isEmbeddingActive && (
				<View style={styles.progressRow}>
					<View style={styles.progressLabel}>
						<Ionicons
							name="sparkles-outline"
							size={14}
							color={colors.mutedForeground}
						/>
						<Text style={[styles.progressText, { color: colors.foreground }]}>
							Indexing
						</Text>
					</View>
					<View style={styles.progressInfo}>
						<Text
							style={[styles.progressCount, { color: colors.mutedForeground }]}
						>
							{embeddingProgress.current} / {embeddingProgress.total}
						</Text>
					</View>
					<ProgressBar
						current={embeddingProgress.current}
						total={embeddingProgress.total}
						color="#22c55e"
					/>
				</View>
			)}
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
