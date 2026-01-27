import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import { formatDate, formatFileSize } from "@photobrain/utils";
import type { inferRouterOutputs } from "@trpc/server";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import React, { useCallback, useRef, useState } from "react";
import {
	Dimensions,
	FlatList,
	Pressable,
	StyleSheet,
	Text,
	View,
	type ViewToken,
} from "react-native";
import { useColors } from "@/theme";

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

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

export default function LoupeView({
	photos,
	initialIndex,
	apiUrl,
	onClose,
	onIndexChange,
	onShowMetadata,
}: LoupeViewProps) {
	const colors = useColors();
	const flatListRef = useRef<FlatList>(null);
	const [currentIndex, setCurrentIndex] = useState(initialIndex);
	const currentPhoto = photos[currentIndex];

	const handleViewableItemsChanged = useCallback(
		({ viewableItems }: { viewableItems: ViewToken[] }) => {
			if (viewableItems.length > 0) {
				const index = viewableItems[0].index ?? 0;
				setCurrentIndex(index);
				onIndexChange(index);
			}
		},
		[onIndexChange],
	);

	const viewabilityConfig = useRef({
		itemVisiblePercentThreshold: 50,
	}).current;

	const navigatePrev = useCallback(() => {
		if (currentIndex > 0) {
			Haptics.selectionAsync();
			flatListRef.current?.scrollToIndex({
				index: currentIndex - 1,
				animated: true,
			});
		}
	}, [currentIndex]);

	const navigateNext = useCallback(() => {
		if (currentIndex < photos.length - 1) {
			Haptics.selectionAsync();
			flatListRef.current?.scrollToIndex({
				index: currentIndex + 1,
				animated: true,
			});
		}
	}, [currentIndex, photos.length]);

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

	return (
		<View style={[styles.container, { backgroundColor: colors.background }]}>
			{/* Header */}
			<View style={[styles.header, { backgroundColor: colors.toolbar }]}>
				<Pressable onPress={onClose} style={styles.headerButton}>
					<Ionicons name="close" size={28} color={colors.foreground} />
				</Pressable>

				<View style={styles.headerTitle}>
					<Text
						style={[styles.photoName, { color: colors.foreground }]}
						numberOfLines={1}
					>
						{currentPhoto?.name ?? ""}
					</Text>
					<Text
						style={[styles.photoCounter, { color: colors.mutedForeground }]}
					>
						{currentIndex + 1} / {photos.length}
					</Text>
				</View>

				<Pressable
					onPress={() => currentPhoto && onShowMetadata(currentPhoto)}
					style={styles.headerButton}
				>
					<Ionicons
						name="information-circle-outline"
						size={28}
						color={colors.foreground}
					/>
				</Pressable>
			</View>

			{/* Photo viewer with swipe */}
			<FlatList
				ref={flatListRef}
				data={photos}
				renderItem={renderPhoto}
				keyExtractor={(item) => item.id.toString()}
				horizontal
				pagingEnabled
				showsHorizontalScrollIndicator={false}
				initialScrollIndex={initialIndex}
				getItemLayout={getItemLayout}
				onViewableItemsChanged={handleViewableItemsChanged}
				viewabilityConfig={viewabilityConfig}
				decelerationRate="fast"
				bounces={false}
			/>

			{/* Navigation arrows */}
			{currentIndex > 0 && (
				<Pressable
					style={[styles.navButton, styles.navButtonLeft]}
					onPress={navigatePrev}
				>
					<View style={[styles.navButtonBg, { backgroundColor: colors.card }]}>
						<Ionicons name="chevron-back" size={32} color={colors.foreground} />
					</View>
				</Pressable>
			)}

			{currentIndex < photos.length - 1 && (
				<Pressable
					style={[styles.navButton, styles.navButtonRight]}
					onPress={navigateNext}
				>
					<View style={[styles.navButtonBg, { backgroundColor: colors.card }]}>
						<Ionicons
							name="chevron-forward"
							size={32}
							color={colors.foreground}
						/>
					</View>
				</Pressable>
			)}

			{/* Bottom info bar */}
			<View style={[styles.bottomBar, { backgroundColor: colors.toolbar }]}>
				<View style={styles.infoChips}>
					{currentPhoto?.isRaw && (
						<View style={[styles.chip, { backgroundColor: "#f97316" }]}>
							<Text style={styles.chipText}>
								{currentPhoto.rawFormat || "RAW"}
							</Text>
						</View>
					)}
					{currentPhoto && (
						<>
							<Text
								style={[styles.infoText, { color: colors.mutedForeground }]}
							>
								{formatFileSize(currentPhoto.size)}
							</Text>
							{currentPhoto.width && currentPhoto.height && (
								<Text
									style={[styles.infoText, { color: colors.mutedForeground }]}
								>
									{currentPhoto.width} x {currentPhoto.height}
								</Text>
							)}
							<Text
								style={[styles.infoText, { color: colors.mutedForeground }]}
							>
								{formatDate(currentPhoto.modifiedAt)}
							</Text>
						</>
					)}
				</View>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	header: {
		flexDirection: "row",
		alignItems: "center",
		paddingTop: 48,
		paddingBottom: 12,
		paddingHorizontal: 8,
	},
	headerButton: {
		padding: 8,
	},
	headerTitle: {
		flex: 1,
		alignItems: "center",
	},
	photoName: {
		fontSize: 16,
		fontWeight: "600",
	},
	photoCounter: {
		fontSize: 12,
		marginTop: 2,
	},
	photoContainer: {
		width: SCREEN_WIDTH,
		height: SCREEN_HEIGHT - 160,
		justifyContent: "center",
		alignItems: "center",
	},
	photo: {
		width: SCREEN_WIDTH,
		height: "100%",
	},
	navButton: {
		position: "absolute",
		top: "50%",
		marginTop: -24,
		zIndex: 10,
	},
	navButtonLeft: {
		left: 8,
	},
	navButtonRight: {
		right: 8,
	},
	navButtonBg: {
		width: 48,
		height: 48,
		borderRadius: 24,
		justifyContent: "center",
		alignItems: "center",
		opacity: 0.9,
	},
	bottomBar: {
		paddingVertical: 12,
		paddingHorizontal: 16,
		paddingBottom: 32,
	},
	infoChips: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		flexWrap: "wrap",
	},
	chip: {
		paddingHorizontal: 8,
		paddingVertical: 4,
		borderRadius: 4,
	},
	chipText: {
		color: "#ffffff",
		fontSize: 12,
		fontWeight: "600",
	},
	infoText: {
		fontSize: 13,
	},
});
