import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import { formatDate, formatFileSize, parseDate } from "@photobrain/utils";
import type { inferRouterOutputs } from "@trpc/server";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import React, { useCallback, useRef, useState } from "react";
import {
	Dimensions,
	FlatList,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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
	const flatListRef = useRef<FlatList>(null);
	const [currentIndex, setCurrentIndex] = useState(initialIndex);
	const currentPhoto = photos[currentIndex];

	const handleMomentumScrollEnd = useCallback(
		(event: NativeSyntheticEvent<NativeScrollEvent>) => {
			const offsetX = event.nativeEvent.contentOffset.x;
			const index = Math.round(offsetX / SCREEN_WIDTH);
			if (index >= 0 && index < photos.length) {
				setCurrentIndex(index);
				onIndexChange(index);
			}
		},
		[onIndexChange, photos.length],
	);

	const renderPhoto = useCallback(
		({ item }: { item: PhotoMetadata }) => (
			<View style={styles.photoContainer}>
				<Image
					source={{ uri: `${apiUrl}/api/photos/${item.id}/thumbnail/large` }}
					placeholder={{
						uri: `${apiUrl}/api/photos/${item.id}/thumbnail/small`,
					}}
					style={styles.photo}
					contentFit="contain"
					priority="high"
					cachePolicy="memory-disk"
				/>
			</View>
		),
		[apiUrl],
	);

	const getItemLayout = useCallback(
		(_: unknown, index: number) => ({
			length: SCREEN_WIDTH,
			offset: SCREEN_WIDTH * index,
			index,
		}),
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
			{/* Photo viewer */}
			<FlatList
				testID="loupe-flatlist"
				ref={flatListRef}
				data={photos}
				renderItem={renderPhoto}
				keyExtractor={(item) => item.id.toString()}
				horizontal
				pagingEnabled
				showsHorizontalScrollIndicator={false}
				initialScrollIndex={initialIndex}
				getItemLayout={getItemLayout}
				onMomentumScrollEnd={handleMomentumScrollEnd}
				decelerationRate="fast"
				bounces={false}
			/>

			{/* Top overlay controls */}
			<View style={[styles.topBar, { paddingTop: insets.top + 4 }]}>
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
			<View style={[styles.bottomBar, { paddingBottom: insets.bottom + 8 }]}>
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
	photoContainer: {
		width: SCREEN_WIDTH,
		height: SCREEN_HEIGHT,
		justifyContent: "center",
		alignItems: "center",
	},
	photo: {
		width: SCREEN_WIDTH,
		height: "100%",
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
		background: "transparent",
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
