import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import { formatFileSize, parseDate } from "@photobrain/utils";
import type { inferRouterOutputs } from "@trpc/server";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	Pressable,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gallery, type GalleryRefType } from "react-native-zoom-toolkit";
import { thumbnailUrl } from "@/config";
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
	const galleryRef = useRef<GalleryRefType>(null);
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
		galleryRef.current?.setIndex(safeCurrentIndex);
		onIndexChangeRef.current(safeCurrentIndex);
	}, [currentPhoto, safeCurrentIndex]);

	const handleIndexChange = useCallback((index: number) => {
		if (index === currentIndexRef.current) return;
		currentIndexRef.current = index;
		currentPhotoIdRef.current = photosRef.current[index]?.id ?? null;
		setCurrentIndex(index);
		onIndexChangeRef.current(index);
		void Haptics.selectionAsync();
	}, []);

	const renderItem = useCallback(
		(item: PhotoMetadata) => (
			<Image
				source={{
					uri: thumbnailUrl(item.id, "large", item.thumbnailUpdatedAt),
				}}
				placeholder={{
					uri: thumbnailUrl(item.id, "small", item.thumbnailUpdatedAt),
				}}
				style={{ width, height }}
				contentFit="contain"
				priority="high"
				cachePolicy="memory-disk"
				accessibilityLabel={item.name}
				accessibilityIgnoresInvertColors
			/>
		),
		[height, width],
	);

	if (!currentPhoto) {
		return (
			<View style={styles.container} testID="loupe-view">
				<View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
					<GlassSurface
						style={styles.roundButton}
						fallbackStyle={styles.darkGlassFallback}
						glassEffectStyle="clear"
						colorScheme="dark"
						isInteractive
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
			<Gallery
				ref={galleryRef}
				data={photos}
				renderItem={renderItem}
				keyExtractor={(photo) => photo.id.toString()}
				initialIndex={safeCurrentIndex}
				onIndexChange={handleIndexChange}
				onTap={() => setChromeVisible((visible) => !visible)}
				maxScale={5}
				gap={20}
				pinchMode="clamp"
				allowPinchPanning
				tapOnEdgeToItem
				zoomEnabled
			/>

			{chromeVisible && (
				<>
					<View
						style={[styles.topBar, { paddingTop: insets.top + 8 }]}
						pointerEvents="box-none"
					>
						<GlassSurface
							style={styles.roundButton}
							fallbackStyle={styles.darkGlassFallback}
							glassEffectStyle="clear"
							colorScheme="dark"
							isInteractive
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
							style={styles.counterPill}
							fallbackStyle={styles.darkGlassFallback}
							glassEffectStyle="clear"
							colorScheme="dark"
						>
							<Text style={styles.counterText}>
								{safeCurrentIndex + 1} of {photos.length}
							</Text>
						</GlassSurface>
					</View>

					<View
						style={[styles.bottomBar, { paddingBottom: insets.bottom + 10 }]}
						pointerEvents="box-none"
					>
						<GlassSurface
							style={styles.infoCard}
							fallbackStyle={styles.darkGlassFallback}
							glassEffectStyle="regular"
							colorScheme="dark"
						>
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
						</GlassSurface>
					</View>
				</>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, backgroundColor: "#000000" },
	darkGlassFallback: { backgroundColor: "rgba(28,28,30,0.9)" },
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
