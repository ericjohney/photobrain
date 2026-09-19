import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import { Image } from "expo-image";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";
import { thumbnailUrl } from "@/config";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface FilmstripProps {
	photos: PhotoMetadata[];
	activePhotoId: number | null;
	onPhotoPress: (photo: PhotoMetadata) => void;
}

const ITEM_WIDTH = 52;

export default function Filmstrip({
	photos,
	activePhotoId,
	onPhotoPress,
}: FilmstripProps) {
	const flatListRef = useRef<FlatList<PhotoMetadata>>(null);
	const [width, setWidth] = useState(0);
	const activeIndex = Math.max(
		0,
		photos.findIndex((photo) => photo.id === activePhotoId),
	);
	const edgePadding = Math.max(0, (width - ITEM_WIDTH) / 2);
	const centerActivePhoto = useCallback(() => {
		if (width === 0 || photos.length === 0) return;
		flatListRef.current?.scrollToOffset({
			offset: activeIndex * ITEM_WIDTH,
			animated: false,
		});
	}, [activeIndex, photos.length, width]);

	useEffect(() => {
		centerActivePhoto();
	}, [centerActivePhoto]);

	const renderItem = useCallback(
		({ item, index }: { item: PhotoMetadata; index: number }) => (
			<Pressable
				accessibilityRole="button"
				accessibilityLabel={`View photo ${index + 1}: ${item.name}`}
				accessibilityState={{ selected: activePhotoId === item.id }}
				onPress={() => onPhotoPress(item)}
				style={styles.target}
			>
				<View
					style={[
						styles.thumbnail,
						activePhotoId === item.id && styles.selected,
					]}
				>
					<Image
						testID={`filmstrip-thumbnail-${item.id}`}
						source={{
							uri: thumbnailUrl(item.id, "small", item.thumbnailUpdatedAt),
						}}
						style={styles.thumbnailImage}
						contentFit="cover"
						cachePolicy="memory-disk"
						accessibilityIgnoresInvertColors
					/>
				</View>
			</Pressable>
		),
		[activePhotoId, onPhotoPress],
	);

	if (photos.length === 0) return null;

	return (
		<View
			style={styles.container}
			onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
		>
			<FlatList
				ref={flatListRef}
				testID="loupe-filmstrip"
				data={photos}
				extraData={activePhotoId}
				renderItem={renderItem}
				keyExtractor={(photo) => photo.id.toString()}
				horizontal
				showsHorizontalScrollIndicator={false}
				initialScrollIndex={activeIndex}
				getItemLayout={(_, index) => ({
					length: ITEM_WIDTH,
					offset: edgePadding + ITEM_WIDTH * index,
					index,
				})}
				onContentSizeChange={centerActivePhoto}
				initialNumToRender={15}
				maxToRenderPerBatch={10}
				windowSize={5}
				contentContainerStyle={{ paddingHorizontal: edgePadding }}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { height: 68 },
	target: {
		width: ITEM_WIDTH,
		height: 68,
		justifyContent: "center",
		alignItems: "center",
	},
	thumbnail: {
		width: 48,
		height: 58,
		borderRadius: 6,
		borderWidth: 2,
		borderColor: "transparent",
		backgroundColor: "#1c1c1e",
		overflow: "hidden",
	},
	selected: { borderColor: "#ffffff" },
	thumbnailImage: { width: "100%", height: "100%" },
});
