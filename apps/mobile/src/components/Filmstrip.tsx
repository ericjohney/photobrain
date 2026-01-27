import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import React, { useCallback, useEffect, useRef } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { useColors } from "@/theme";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface FilmstripProps {
	photos: PhotoMetadata[];
	activePhotoId: number | null;
	selectedPhotos: Set<number>;
	apiUrl: string;
	onPhotoPress: (photo: PhotoMetadata) => void;
}

const THUMBNAIL_SIZE = 60;
const THUMBNAIL_SPACING = 2;

export default function Filmstrip({
	photos,
	activePhotoId,
	selectedPhotos,
	apiUrl,
	onPhotoPress,
}: FilmstripProps) {
	const colors = useColors();
	const flatListRef = useRef<FlatList>(null);

	// Scroll to active photo when it changes
	useEffect(() => {
		if (activePhotoId !== null) {
			const index = photos.findIndex((p) => p.id === activePhotoId);
			if (index >= 0 && flatListRef.current) {
				flatListRef.current.scrollToIndex({
					index,
					animated: true,
					viewPosition: 0.5,
				});
			}
		}
	}, [activePhotoId, photos]);

	const handlePress = useCallback(
		(photo: PhotoMetadata) => {
			Haptics.selectionAsync();
			onPhotoPress(photo);
		},
		[onPhotoPress],
	);

	const renderItem = useCallback(
		({ item }: { item: PhotoMetadata }) => {
			const isActive = activePhotoId === item.id;
			const isSelected = selectedPhotos.has(item.id);

			return (
				<Pressable
					onPress={() => handlePress(item)}
					style={[
						styles.thumbnail,
						{ backgroundColor: colors.muted },
						isActive && { borderColor: colors.selection, borderWidth: 2 },
						isSelected &&
							!isActive && {
								borderColor: colors.selectionMuted,
								borderWidth: 1,
							},
					]}
				>
					<Image
						source={{ uri: `${apiUrl}/api/photos/${item.id}/thumbnail/tiny` }}
						style={styles.thumbnailImage}
						contentFit="cover"
						cachePolicy="memory-disk"
					/>
					{/* RAW indicator */}
					{item.isRaw && (
						<View style={styles.rawBadge}>
							<View style={styles.rawDot} />
						</View>
					)}
				</Pressable>
			);
		},
		[activePhotoId, selectedPhotos, apiUrl, colors, handlePress],
	);

	const getItemLayout = useCallback(
		(_: unknown, index: number) => ({
			length: THUMBNAIL_SIZE + THUMBNAIL_SPACING,
			offset: (THUMBNAIL_SIZE + THUMBNAIL_SPACING) * index,
			index,
		}),
		[],
	);

	const keyExtractor = useCallback(
		(item: PhotoMetadata) => item.id.toString(),
		[],
	);

	if (photos.length === 0) {
		return null;
	}

	return (
		<View style={[styles.container, { backgroundColor: colors.filmstrip }]}>
			<FlatList
				ref={flatListRef}
				data={photos}
				renderItem={renderItem}
				keyExtractor={keyExtractor}
				horizontal
				showsHorizontalScrollIndicator={false}
				getItemLayout={getItemLayout}
				initialNumToRender={15}
				maxToRenderPerBatch={10}
				windowSize={5}
				contentContainerStyle={styles.contentContainer}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		height: THUMBNAIL_SIZE + 16,
		paddingVertical: 8,
	},
	contentContainer: {
		paddingHorizontal: 8,
		gap: THUMBNAIL_SPACING,
	},
	thumbnail: {
		width: THUMBNAIL_SIZE,
		height: THUMBNAIL_SIZE,
		borderRadius: 4,
		overflow: "hidden",
		marginHorizontal: THUMBNAIL_SPACING / 2,
	},
	thumbnailImage: {
		width: "100%",
		height: "100%",
	},
	rawBadge: {
		position: "absolute",
		top: 4,
		left: 4,
	},
	rawDot: {
		width: 6,
		height: 6,
		borderRadius: 3,
		backgroundColor: "#f97316",
	},
});
