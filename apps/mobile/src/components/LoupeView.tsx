import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import { formatFileSize, parseDate } from "@photobrain/utils";
import type { inferRouterOutputs } from "@trpc/server";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import React, { useCallback, useState } from "react";
import { Dimensions, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gallery } from "react-native-zoom-toolkit";
import { thumbnailUrl } from "@/config";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface LoupeViewProps {
	photos: PhotoMetadata[];
	initialIndex: number;
	apiUrl: string;
	onClose: () => void;
	onIndexChange: (index: number) => void;
	onShowMetadata: (photo: PhotoMetadata) => void;
}

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } =
	Dimensions.get("window");

export default function LoupeView({
	photos,
	initialIndex,
	apiUrl,
	onClose,
	onIndexChange,
	onShowMetadata,
}: LoupeViewProps) {
	const insets = useSafeAreaInsets();
	const [currentIndex, setCurrentIndex] = useState(initialIndex);
	const currentPhoto = photos[currentIndex];

	const handleIndexChange = useCallback(
		(index: number) => {
			setCurrentIndex(index);
			onIndexChange(index);
		},
		[onIndexChange],
	);

	const renderItem = useCallback(
		(item: PhotoMetadata, _index: number) => (
			<Image
				source={{ uri: thumbnailUrl(item.id, "large") }}
				placeholder={{
					uri: thumbnailUrl(item.id, "small"),
				}}
				style={styles.image}
				contentFit="contain"
				priority="high"
				cachePolicy="memory-disk"
			/>
		),
		[],
	);

	const keyExtractor = useCallback(
		(item: PhotoMetadata, _index: number) => item.id.toString(),
		[],
	);

	// Format the date nicely
	const photoDate = currentPhoto?.exif?.dateTaken || currentPhoto?.modifiedAt;
	const dateObj = photoDate ? parseDate(photoDate) : null;
	const formattedDate = dateObj
		? dateObj.toLocaleDateString("en-US", {
				weekday: "short",
				month: "short",
				day: "numeric",
				year: "numeric",
			})
		: "";
	const formattedTime = dateObj
		? dateObj.toLocaleTimeString("en-US", {
				hour: "numeric",
				minute: "2-digit",
			})
		: "";

	return (
		<View style={styles.container}>
			{/* Photo viewer with built-in pinch/pan/double-tap zoom */}
			<Gallery
				data={photos}
				renderItem={renderItem}
				keyExtractor={keyExtractor}
				initialIndex={initialIndex}
				onIndexChange={handleIndexChange}
				maxScale={5}
				gap={20}
				pinchMode="clamp"
				allowPinchPanning
				tapOnEdgeToItem
				zoomEnabled
			/>

			{/* Top overlay controls */}
			<View
				style={[styles.topBar, { paddingTop: insets.top + 4 }]}
				pointerEvents="box-none"
			>
				<Pressable onPress={onClose} style={styles.topButton}>
					<Ionicons name="chevron-back" size={28} color="#ffffff" />
				</Pressable>

				<View style={styles.topActions}>
					<Pressable style={styles.topButton}>
						<Ionicons name="star-outline" size={24} color="#ffffff" />
					</Pressable>
					<Pressable style={styles.topButton}>
						<Ionicons
							name="ellipsis-horizontal"
							size={24}
							color="#ffffff"
						/>
					</Pressable>
				</View>
			</View>

			{/* Bottom overlay */}
			<View
				style={[styles.bottomBar, { paddingBottom: insets.bottom + 8 }]}
				pointerEvents="box-none"
			>
				{/* Date and info */}
				<View style={styles.dateRow}>
					<View>
						<Text style={styles.dateText}>{formattedDate}</Text>
						<Text style={styles.timeText}>
							{formattedTime}
							{currentPhoto?.width && currentPhoto?.height
								? `  ·  ${currentPhoto.width} × ${currentPhoto.height}`
								: ""}
							{currentPhoto
								? `  ·  ${formatFileSize(currentPhoto.size)}`
								: ""}
						</Text>
					</View>
				</View>

				{/* Action buttons */}
				<View style={styles.actionRow}>
					<Pressable
						style={styles.actionButton}
						onPress={() => {
							Haptics.selectionAsync();
						}}
					>
						<Ionicons name="share-outline" size={24} color="#ffffff" />
						<Text style={styles.actionLabel}>Share</Text>
					</Pressable>

					<Pressable
						style={styles.actionButton}
						onPress={() => {
							Haptics.selectionAsync();
						}}
					>
						<Ionicons name="heart-outline" size={24} color="#ffffff" />
						<Text style={styles.actionLabel}>Like</Text>
					</Pressable>

					<Pressable
						style={styles.actionButton}
						onPress={() => {
							Haptics.selectionAsync();
							if (currentPhoto) onShowMetadata(currentPhoto);
						}}
					>
						<Ionicons
							name="information-circle-outline"
							size={24}
							color="#ffffff"
						/>
						<Text style={styles.actionLabel}>Info</Text>
					</Pressable>

					<Pressable
						style={styles.actionButton}
						onPress={() => {
							Haptics.selectionAsync();
						}}
					>
						<Ionicons name="trash-outline" size={24} color="#ffffff" />
						<Text style={styles.actionLabel}>Delete</Text>
					</Pressable>
				</View>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#000000",
	},
	image: {
		width: SCREEN_WIDTH,
		height: SCREEN_HEIGHT,
	},
	topBar: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		paddingHorizontal: 4,
		paddingBottom: 8,
	},
	topButton: {
		padding: 10,
	},
	topActions: {
		flexDirection: "row",
		alignItems: "center",
	},
	bottomBar: {
		position: "absolute",
		bottom: 0,
		left: 0,
		right: 0,
		paddingHorizontal: 16,
		paddingTop: 16,
	},
	dateRow: {
		marginBottom: 16,
	},
	dateText: {
		color: "#ffffff",
		fontSize: 15,
		fontWeight: "600",
	},
	timeText: {
		color: "rgba(255,255,255,0.65)",
		fontSize: 13,
		marginTop: 2,
	},
	actionRow: {
		flexDirection: "row",
		justifyContent: "space-around",
		paddingTop: 12,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: "rgba(255,255,255,0.15)",
	},
	actionButton: {
		alignItems: "center",
		gap: 4,
		paddingVertical: 4,
		paddingHorizontal: 16,
	},
	actionLabel: {
		color: "rgba(255,255,255,0.7)",
		fontSize: 11,
		fontWeight: "500",
	},
});
