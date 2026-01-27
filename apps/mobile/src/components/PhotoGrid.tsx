import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import React, { useCallback } from "react";
import {
	Dimensions,
	FlatList,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useColors } from "@/theme";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface PhotoGridProps {
	photos: PhotoMetadata[];
	selectedPhotos?: Set<number>;
	activePhotoId?: number | null;
	onPhotoPress: (photo: PhotoMetadata) => void;
	onPhotoLongPress?: (photo: PhotoMetadata) => void;
	onPhotoDoublePress?: (photo: PhotoMetadata) => void;
	apiUrl: string;
}

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const COLUMNS = 3;
const SPACING = 2;
const ITEM_SIZE = (SCREEN_WIDTH - SPACING * (COLUMNS + 1)) / COLUMNS;

export default function PhotoGrid({
	photos,
	selectedPhotos = new Set(),
	activePhotoId = null,
	onPhotoPress,
	onPhotoLongPress,
	onPhotoDoublePress,
	apiUrl,
}: PhotoGridProps) {
	const colors = useColors();

	const handlePress = useCallback(
		(photo: PhotoMetadata) => {
			Haptics.selectionAsync();
			onPhotoPress(photo);
		},
		[onPhotoPress],
	);

	const handleLongPress = useCallback(
		(photo: PhotoMetadata) => {
			if (onPhotoLongPress) {
				Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
				onPhotoLongPress(photo);
			}
		},
		[onPhotoLongPress],
	);

	const renderItem = useCallback(
		({ item }: { item: PhotoMetadata }) => {
			const isSelected = selectedPhotos.has(item.id);
			const isActive = activePhotoId === item.id;
			const isFailedRaw = item.isRaw && item.rawStatus !== "converted";

			return (
				<Pressable
					onPress={() => handlePress(item)}
					onLongPress={() => handleLongPress(item)}
					style={[
						styles.photoContainer,
						{ backgroundColor: colors.muted },
						isSelected && {
							borderColor: colors.selection,
							borderWidth: 2,
						},
						isActive &&
							!isSelected && {
								borderColor: colors.selectionMuted,
								borderWidth: 2,
							},
					]}
				>
					{isFailedRaw ? (
						<View style={styles.failedContainer}>
							<Ionicons
								name="camera-outline"
								size={24}
								color={colors.mutedForeground}
							/>
							<Text
								style={[styles.failedText, { color: colors.mutedForeground }]}
							>
								{item.rawStatus === "no_converter" ? "No Converter" : "Failed"}
							</Text>
						</View>
					) : (
						<Image
							source={{ uri: `${apiUrl}/api/photos/${item.id}/thumbnail/tiny` }}
							style={styles.photo}
							contentFit="cover"
							transition={200}
							cachePolicy="memory-disk"
							placeholder={{ blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4" }}
						/>
					)}

					{/* RAW badge */}
					{item.isRaw && (
						<View style={styles.rawBadge}>
							<Text style={styles.rawBadgeText}>{item.rawFormat || "RAW"}</Text>
						</View>
					)}

					{/* Failed indicator */}
					{item.isRaw && item.rawStatus === "failed" && (
						<View style={styles.failedIndicator}>
							<Ionicons name="alert-circle" size={14} color="#ef4444" />
						</View>
					)}

					{/* Selection overlay */}
					{isSelected && (
						<View
							style={[
								styles.selectionOverlay,
								{ backgroundColor: `${colors.selection}20` },
							]}
						>
							<View
								style={[
									styles.checkmark,
									{ backgroundColor: colors.selection },
								]}
							>
								<Ionicons name="checkmark" size={14} color="#ffffff" />
							</View>
						</View>
					)}
				</Pressable>
			);
		},
		[
			selectedPhotos,
			activePhotoId,
			apiUrl,
			colors,
			handlePress,
			handleLongPress,
		],
	);

	const keyExtractor = useCallback(
		(item: PhotoMetadata) => item.id.toString(),
		[],
	);

	if (photos.length === 0) {
		return (
			<View style={styles.emptyContainer}>
				<Ionicons
					name="images-outline"
					size={64}
					color={colors.mutedForeground}
					style={{ opacity: 0.3 }}
				/>
				<Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
					No photos found
				</Text>
				<Text style={[styles.emptySubtext, { color: colors.mutedForeground }]}>
					Try adjusting your search or scan for photos
				</Text>
			</View>
		);
	}

	return (
		<FlatList
			data={photos}
			keyExtractor={keyExtractor}
			numColumns={COLUMNS}
			contentContainerStyle={[
				styles.container,
				{ backgroundColor: colors.background },
			]}
			renderItem={renderItem}
			initialNumToRender={21}
			maxToRenderPerBatch={15}
			windowSize={5}
			removeClippedSubviews={true}
		/>
	);
}

const styles = StyleSheet.create({
	container: {
		padding: SPACING,
	},
	photoContainer: {
		margin: SPACING / 2,
		width: ITEM_SIZE,
		height: ITEM_SIZE,
		borderRadius: 4,
		overflow: "hidden",
	},
	photo: {
		width: "100%",
		height: "100%",
	},
	failedContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		gap: 4,
	},
	failedText: {
		fontSize: 10,
	},
	rawBadge: {
		position: "absolute",
		top: 4,
		left: 4,
		backgroundColor: "rgba(249, 115, 22, 0.9)",
		paddingHorizontal: 4,
		paddingVertical: 2,
		borderRadius: 3,
	},
	rawBadgeText: {
		color: "#ffffff",
		fontSize: 9,
		fontWeight: "700",
	},
	failedIndicator: {
		position: "absolute",
		top: 4,
		right: 4,
	},
	selectionOverlay: {
		...StyleSheet.absoluteFillObject,
	},
	checkmark: {
		position: "absolute",
		bottom: 4,
		right: 4,
		width: 20,
		height: 20,
		borderRadius: 10,
		justifyContent: "center",
		alignItems: "center",
	},
	emptyContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		padding: 24,
		gap: 8,
	},
	emptyText: {
		fontSize: 16,
		fontWeight: "500",
	},
	emptySubtext: {
		fontSize: 14,
		textAlign: "center",
	},
});
