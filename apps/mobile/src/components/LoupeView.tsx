import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import { parseDate } from "@photobrain/utils";
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
import Filmstrip from "./Filmstrip";
import GlassSurface from "./GlassSurface";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface LoupeViewProps {
	photos: PhotoMetadata[];
	initialIndex: number;
	onClose: () => void;
	onIndexChange: (index: number) => void;
	onShowMetadata: (photo: PhotoMetadata) => void;
}

function LoupePhoto({
	photo,
	width,
	height,
	onPress,
}: {
	photo: PhotoMetadata;
	width: number;
	height: number;
	onPress: () => void;
}) {
	const [failed, setFailed] = useState(false);
	const insets = useSafeAreaInsets();

	if (failed) {
		return (
			<Pressable
				testID={`loupe-photo-error-${photo.id}`}
				accessible={false}
				onPress={onPress}
				style={[
					styles.photoError,
					{
						width,
						height,
						paddingLeft: insets.left + 24,
						paddingRight: insets.right + 24,
					},
				]}
			>
				<Text style={styles.dateText}>Unable to load photo</Text>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={`Retry loading ${photo.name}`}
					onPress={() => setFailed(false)}
					style={[styles.retryButton, styles.chromeSurface]}
				>
					<Text style={styles.counterText}>Retry</Text>
				</Pressable>
			</Pressable>
		);
	}

	return (
		<Pressable
			accessibilityRole="button"
			accessibilityLabel={photo.name}
			onPress={onPress}
			style={{ width, height }}
		>
			<Image
				source={{
					uri: thumbnailUrl(photo.id, "large", photo.thumbnailUpdatedAt),
				}}
				placeholder={{
					uri: thumbnailUrl(photo.id, "small", photo.thumbnailUpdatedAt),
				}}
				onError={() => setFailed(true)}
				style={styles.photo}
				contentFit="contain"
				priority="high"
				cachePolicy="memory-disk"
				accessibilityIgnoresInvertColors
			/>
		</Pressable>
	);
}

function LoupePage({
	photo,
	width,
	height,
	active,
	onPress,
	onZoomChange,
}: {
	photo: PhotoMetadata;
	width: number;
	height: number;
	active: boolean;
	onPress: () => void;
	onZoomChange: (zoomed: boolean) => void;
}) {
	const zoomRef = useRef<ScrollView>(null);

	useEffect(() => {
		if (Platform.OS !== "ios" || width === 0 || height === 0) return;
		zoomRef.current?.scrollResponderZoomTo({
			x: 0,
			y: 0,
			width,
			height,
			animated: false,
		});
		if (active) onZoomChange(false);
	}, [active, height, onZoomChange, width]);

	const image = (
		<LoupePhoto
			key={thumbnailUrl(photo.id, "large", photo.thumbnailUpdatedAt)}
			photo={photo}
			width={width}
			height={height}
			onPress={onPress}
		/>
	);
	if (Platform.OS !== "ios") return image;

	return (
		<ScrollView
			ref={zoomRef}
			testID={`loupe-zoom-${photo.id}`}
			style={{ width, height }}
			contentContainerStyle={{ width, height }}
			minimumZoomScale={1}
			maximumZoomScale={5}
			bouncesZoom
			centerContent
			showsHorizontalScrollIndicator={false}
			showsVerticalScrollIndicator={false}
			scrollEventThrottle={16}
			onScroll={(event) => {
				if (active) onZoomChange((event.nativeEvent.zoomScale ?? 1) > 1.01);
			}}
		>
			{image}
		</ScrollView>
	);
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
	const [zoomed, setZoomed] = useState(false);
	const toggleChrome = useCallback(
		() => setChromeVisible((visible) => !visible),
		[],
	);
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
		setZoomed(false);
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

	const handleThumbnailPress = useCallback(
		(photo: PhotoMetadata) => {
			const index = photosRef.current.findIndex((item) => item.id === photo.id);
			if (index < 0 || index === currentIndexRef.current) return;
			handleIndexChange(index);
			galleryRef.current?.scrollToOffset({
				offset: index * width,
				animated: false,
			});
		},
		[handleIndexChange, width],
	);

	const renderItem = useCallback(
		({ item }: { item: PhotoMetadata }) => (
			<LoupePage
				photo={item}
				width={width}
				height={height}
				active={item.id === currentPhoto?.id}
				onPress={toggleChrome}
				onZoomChange={setZoomed}
			/>
		),
		[currentPhoto?.id, height, toggleChrome, width],
	);

	if (!currentPhoto) {
		return (
			<View style={styles.container} testID="loupe-view">
				<View
					testID="loupe-top-bar"
					style={[
						styles.topBar,
						{
							paddingTop: insets.top + 8,
							paddingLeft: insets.left + 14,
							paddingRight: insets.right + 14,
						},
					]}
				>
					<GlassSurface
						style={styles.roundButton}
						fallbackStyle={styles.chromeSurface}
						colorScheme="dark"
					>
						<Pressable
							accessibilityRole="button"
							accessibilityLabel="Close photo"
							onPress={onClose}
							style={styles.buttonHitArea}
						>
							<Ionicons name="chevron-down" size={23} color="#ffffff" />
						</Pressable>
					</GlassSurface>
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
				scrollEnabled={!zoomed}
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
						testID="loupe-top-bar"
						style={[
							styles.topBar,
							{
								paddingTop: insets.top + 8,
								paddingLeft: insets.left + 14,
								paddingRight: insets.right + 14,
							},
						]}
						pointerEvents="box-none"
					>
						<GlassSurface
							style={styles.roundButton}
							fallbackStyle={styles.chromeSurface}
							colorScheme="dark"
						>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel="Close photo"
								onPress={onClose}
								style={styles.buttonHitArea}
							>
								<Ionicons name="chevron-down" size={23} color="#ffffff" />
							</Pressable>
						</GlassSurface>
						<GlassSurface
							style={styles.datePill}
							fallbackStyle={styles.chromeSurface}
							colorScheme="dark"
							pointerEvents="none"
						>
							<Text style={styles.dateText}>{formattedDate}</Text>
							<Text style={styles.timeText}>{formattedTime}</Text>
						</GlassSurface>
					</View>

					<View
						testID="loupe-bottom-bar"
						style={[
							styles.bottomBar,
							{
								paddingBottom: insets.bottom + 10,
								left: insets.left + 12,
								right: insets.right + 12,
							},
						]}
						pointerEvents="box-none"
					>
						<Filmstrip
							photos={photos}
							activePhotoId={currentPhoto.id}
							onPhotoPress={handleThumbnailPress}
						/>
						<View style={styles.bottomActions} pointerEvents="box-none">
							<GlassSurface
								style={styles.counterPill}
								fallbackStyle={styles.chromeSurface}
								colorScheme="dark"
								pointerEvents="none"
							>
								<Text style={styles.counterText}>
									{safeCurrentIndex + 1} of {photos.length}
								</Text>
							</GlassSurface>
							<GlassSurface
								style={styles.roundButton}
								fallbackStyle={styles.chromeSurface}
								colorScheme="dark"
							>
								<Pressable
									accessibilityRole="button"
									accessibilityLabel="Show photo info"
									onPress={() => {
										void Haptics.selectionAsync();
										onShowMetadata(currentPhoto);
									}}
									style={styles.buttonHitArea}
								>
									<Ionicons
										name="information-circle"
										size={26}
										color="#ffffff"
									/>
								</Pressable>
							</GlassSurface>
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
	photoError: { alignItems: "center", justifyContent: "center", gap: 12 },
	retryButton: {
		minHeight: 44,
		paddingHorizontal: 20,
		justifyContent: "center",
		borderRadius: 22,
	},
	chromeSurface: { backgroundColor: "#1c1c1e" },
	topBar: {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 12,
	},
	roundButton: {
		width: 44,
		height: 44,
		flexShrink: 0,
		borderRadius: 22,
		borderCurve: "continuous",
		overflow: "hidden",
	},
	buttonHitArea: { flex: 1, alignItems: "center", justifyContent: "center" },
	datePill: {
		flexShrink: 1,
		minWidth: 0,
		paddingHorizontal: 16,
		paddingVertical: 8,
		borderRadius: 22,
		borderCurve: "continuous",
	},
	counterPill: {
		flexShrink: 1,
		minWidth: 0,
		minHeight: 44,
		justifyContent: "center",
		paddingVertical: 8,
		paddingHorizontal: 13,
		borderRadius: 18,
		borderCurve: "continuous",
	},
	counterText: { color: "#ffffff", fontSize: 13, fontWeight: "600" },
	bottomBar: { position: "absolute", bottom: 0, gap: 8 },
	bottomActions: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 12,
	},
	dateText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
	timeText: { color: "#e5e5ea", fontSize: 13, marginTop: 2 },
});
