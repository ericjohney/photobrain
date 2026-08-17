import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import { formatFileSize, parseDate } from "@photobrain/utils";
import type { inferRouterOutputs } from "@trpc/server";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	FlatList,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	Platform,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { thumbnailUrl } from "@/config";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface LoupeViewProps {
	photos: PhotoMetadata[];
	initialIndex: number;
	onClose: () => void;
	onIndexChange: (index: number) => void;
	onShowMetadata: (photo: PhotoMetadata) => void;
}

export default function LoupeView({
	photos,
	initialIndex,
	onClose,
	onIndexChange,
	onShowMetadata,
}: LoupeViewProps) {
	const insets = useSafeAreaInsets();
	const { width, height } = useWindowDimensions();
	const openingIndex =
		photos.length > 0
			? Math.min(Math.max(initialIndex, 0), photos.length - 1)
			: 0;
	const [currentIndex, setCurrentIndex] = useState(openingIndex);
	const currentIndexRef = useRef(openingIndex);
	const currentPhotoIdRef = useRef<number | null>(
		photos[openingIndex]?.id ?? null,
	);
	const photosRef = useRef(photos);
	photosRef.current = photos;
	const galleryRef = useRef<FlatList<PhotoMetadata>>(null);
	const onIndexChangeRef = useRef(onIndexChange);
	onIndexChangeRef.current = onIndexChange;
	const [chromeVisible, setChromeVisible] = useState(true);
	const identityIndex = photos.findIndex(
		(photo) => photo.id === currentPhotoIdRef.current,
	);
	const safeCurrentIndex =
		photos.length > 0
			? identityIndex >= 0
				? identityIndex
				: Math.min(currentIndex, photos.length - 1)
			: 0;
	const currentPhoto = photos[safeCurrentIndex];

	useEffect(() => {
		if (!currentPhoto) {
			currentPhotoIdRef.current = null;
			return;
		}
		const identityChanged = currentPhotoIdRef.current !== currentPhoto.id;
		currentPhotoIdRef.current = currentPhoto.id;
		if (safeCurrentIndex === currentIndexRef.current) {
			if (identityChanged) onIndexChangeRef.current(safeCurrentIndex);
			return;
		}
		currentIndexRef.current = safeCurrentIndex;
		setCurrentIndex(safeCurrentIndex);
		if (width > 0) {
			galleryRef.current?.scrollToOffset({
				offset: safeCurrentIndex * width,
				animated: false,
			});
		}
		onIndexChangeRef.current(safeCurrentIndex);
	}, [currentPhoto, safeCurrentIndex, width]);

	useEffect(() => {
		if (width === 0 || photosRef.current.length === 0) return;
		galleryRef.current?.scrollToOffset({
			offset: currentIndexRef.current * width,
			animated: false,
		});
	}, [width]);

	const handleIndexChange = useCallback((index: number) => {
		if (index < 0 || index >= photosRef.current.length) return;
		if (index === currentIndexRef.current) return;
		currentIndexRef.current = index;
		currentPhotoIdRef.current = photosRef.current[index]?.id ?? null;
		setCurrentIndex(index);
		onIndexChangeRef.current(index);
		void Haptics.selectionAsync();
	}, []);
	const handlePageSettled = useCallback(
		(event: NativeSyntheticEvent<NativeScrollEvent>) => {
			if (width === 0) return;
			const offset =
				event.nativeEvent.targetContentOffset?.x ??
				event.nativeEvent.contentOffset.x;
			handleIndexChange(Math.round(offset / width));
		},
		[handleIndexChange, width],
	);

	const renderItem = useCallback(
		({ item }: { item: PhotoMetadata }) => {
			const photo = (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={item.name}
					onPress={() => setChromeVisible((visible) => !visible)}
					style={{ width, height }}
				>
					<Image
						source={{
							uri: thumbnailUrl(item.id, "large", item.thumbnailUpdatedAt),
						}}
						placeholder={{
							uri: thumbnailUrl(item.id, "small", item.thumbnailUpdatedAt),
						}}
						style={styles.photo}
						contentFit="contain"
						priority="high"
						cachePolicy="memory-disk"
						accessibilityIgnoresInvertColors
					/>
				</Pressable>
			);

			if (Platform.OS !== "ios") return photo;

			return (
				<ScrollView
					testID={`loupe-zoom-${item.id}`}
					style={{ width, height }}
					contentContainerStyle={{ width, height }}
					minimumZoomScale={1}
					maximumZoomScale={5}
					bouncesZoom
					centerContent
					showsHorizontalScrollIndicator={false}
					showsVerticalScrollIndicator={false}
				>
					{photo}
				</ScrollView>
			);
		},
		[height, width],
	);

	if (!currentPhoto) {
		return (
			<View style={styles.container} testID="loupe-view">
				<View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
					<View style={[styles.roundButton, styles.chromeSurface]}>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Close photo"
							onPress={onClose}
							style={styles.buttonHitArea}
						>
							<Ionicons name="chevron-down" size={23} color="#ffffff" />
						</Pressable>
					</View>
				</View>
			</View>
		);
	}

	const date = parseDate(
		currentPhoto.exif?.dateTaken ??
			currentPhoto.modifiedAt ??
			currentPhoto.createdAt,
	);
	const formattedDate = date.toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
	});
	const formattedTime = date.toLocaleTimeString(undefined, {
		hour: "numeric",
		minute: "2-digit",
	});

	return (
		<View style={styles.container} testID="loupe-view">
			<FlatList
				ref={galleryRef}
				testID="loupe-gallery"
				data={photos}
				renderItem={renderItem}
				keyExtractor={(photo) => photo.id.toString()}
				horizontal
				pagingEnabled
				showsHorizontalScrollIndicator={false}
				initialScrollIndex={safeCurrentIndex}
				getItemLayout={(_, index) => ({
					length: width,
					offset: width * index,
					index,
				})}
				onScrollEndDrag={handlePageSettled}
				onMomentumScrollEnd={handlePageSettled}
				decelerationRate="fast"
				bounces={false}
				initialNumToRender={1}
				maxToRenderPerBatch={2}
				windowSize={3}
			/>

			{chromeVisible && (
				<>
					<View
						style={[styles.topBar, { paddingTop: insets.top + 8 }]}
						pointerEvents="box-none"
					>
						<View style={[styles.roundButton, styles.chromeSurface]}>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Close photo"
								onPress={onClose}
								style={styles.buttonHitArea}
							>
								<Ionicons name="chevron-down" size={23} color="#ffffff" />
							</Pressable>
						</View>
						<View style={[styles.counterPill, styles.chromeSurface]}>
							<Text style={styles.counterText}>
								{safeCurrentIndex + 1} of {photos.length}
							</Text>
						</View>
					</View>

					<View
						style={[styles.bottomBar, { paddingBottom: insets.bottom + 10 }]}
						pointerEvents="box-none"
					>
						<View style={[styles.infoCard, styles.chromeSurface]}>
							<View style={styles.photoInfo}>
								<Text style={styles.dateText}>{formattedDate}</Text>
								<Text style={styles.detailText} numberOfLines={1}>
									{formattedTime}
									{currentPhoto.width && currentPhoto.height
										? `  ·  ${currentPhoto.width} × ${currentPhoto.height}`
										: ""}
									{`  ·  ${formatFileSize(currentPhoto.size)}`}
								</Text>
							</View>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Show photo info"
								onPress={() => {
									void Haptics.selectionAsync();
									onShowMetadata(currentPhoto);
								}}
								style={styles.infoButton}
							>
								<Ionicons name="information-circle" size={26} color="#ffffff" />
								<Text style={styles.infoLabel}>Info</Text>
							</Pressable>
						</View>
					</View>
				</>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, backgroundColor: "#000000" },
	photo: { width: "100%", height: "100%" },
	chromeSurface: { backgroundColor: "rgba(28,28,30,0.9)" },
	topBar: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		paddingHorizontal: 14,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
	},
	roundButton: {
		width: 44,
		height: 44,
		borderRadius: 22,
		borderCurve: "continuous",
		overflow: "hidden",
	},
	buttonHitArea: { flex: 1, alignItems: "center", justifyContent: "center" },
	counterPill: {
		minHeight: 36,
		justifyContent: "center",
		paddingHorizontal: 13,
		borderRadius: 18,
		borderCurve: "continuous",
	},
	counterText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
	bottomBar: { position: "absolute", left: 12, right: 12, bottom: 0 },
	infoCard: {
		minHeight: 70,
		borderRadius: 24,
		borderCurve: "continuous",
		paddingLeft: 16,
		paddingRight: 8,
		paddingVertical: 8,
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
	},
	photoInfo: { flex: 1, minWidth: 0 },
	dateText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
	detailText: { color: "rgba(255,255,255,0.72)", fontSize: 12, marginTop: 3 },
	infoButton: {
		width: 54,
		minHeight: 54,
		alignItems: "center",
		justifyContent: "center",
	},
	infoLabel: {
		color: "rgba(255,255,255,0.78)",
		fontSize: 10,
		fontWeight: "600",
		marginTop: 1,
	},
});
