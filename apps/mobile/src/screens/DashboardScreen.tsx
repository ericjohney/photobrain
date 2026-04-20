import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";

import React, { useCallback, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Dimensions,
	FlatList,
	Pressable,
	RefreshControl,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import ActivityBar from "@/components/ActivityBar";
import LoupeView from "@/components/LoupeView";
import MetadataPanel from "@/components/MetadataPanel";
import { API_URL } from "@/config";
import { useLibraryState } from "@/hooks/use-library-state";
import { useJobProgress } from "@/hooks/use-job-progress";
import { trpc } from "@/lib/trpc";
import { useColors } from "@/theme";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } =
	Dimensions.get("window");
const COLUMNS = 4;
const SPACING = 1.5;
const ITEM_SIZE = (SCREEN_WIDTH - SPACING * (COLUMNS - 1)) / COLUMNS;

type SectionItem =
	| { type: "month-header"; title: string; key: string }
	| { type: "date-header"; title: string; key: string }
	| { type: "photo-row"; photos: PhotoMetadata[]; key: string };

// EXIF DateTimeOriginal uses "YYYY:MM:DD HH:MM:SS" format which
// JavaScript's Date constructor can't parse. Convert to ISO 8601.
// createdAt/modifiedAt come through as Date objects via superjson,
// while exif.dateTaken is a raw string — handle both.
function parseDate(value: Date | string | null | undefined): Date {
	if (!value) return new Date();
	if (value instanceof Date) return value;
	const parsed = new Date(value.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3"));
	return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function groupPhotosByDate(photos: PhotoMetadata[]): SectionItem[] {
	if (photos.length === 0) return [];

	// Sort photos newest first
	const sorted = [...photos].sort((a, b) => {
		const dateA = a.exif?.dateTaken || a.modifiedAt || a.createdAt;
		const dateB = b.exif?.dateTaken || b.modifiedAt || b.createdAt;
		return parseDate(dateB).getTime() - parseDate(dateA).getTime();
	});

	const items: SectionItem[] = [];
	let lastMonth = "";
	let lastDate = "";
	let currentRow: PhotoMetadata[] = [];

	const flushRow = () => {
		if (currentRow.length > 0) {
			items.push({
				type: "photo-row",
				photos: [...currentRow],
				key: `row-${currentRow[0].id}`,
			});
			currentRow = [];
		}
	};

	for (const photo of sorted) {
		const dateStr = photo.exif?.dateTaken || photo.modifiedAt || photo.createdAt;
		const date = parseDate(dateStr);
		const monthKey = date.toLocaleDateString("en-US", {
			year: "numeric",
			month: "long",
		});
		const dateKey = date.toLocaleDateString("en-US", {
			weekday: "short",
			month: "short",
			day: "numeric",
			year: "numeric",
		});

		if (monthKey !== lastMonth) {
			flushRow();
			items.push({
				type: "month-header",
				title: monthKey,
				key: `month-${monthKey}`,
			});
			lastMonth = monthKey;
			lastDate = "";
		}

		if (dateKey !== lastDate) {
			flushRow();
			items.push({
				type: "date-header",
				title: dateKey,
				key: `date-${dateKey}`,
			});
			lastDate = dateKey;
		}

		currentRow.push(photo);
		if (currentRow.length === COLUMNS) {
			flushRow();
		}
	}
	flushRow();

	return items;
}

export default function DashboardScreen() {
	const colors = useColors();
	const insets = useSafeAreaInsets();
	const [metadataPhoto, setMetadataPhoto] = useState<PhotoMetadata | null>(
		null,
	);
	const [activeJobId, setActiveJobId] = useState<string | null>(null);

	// tRPC queries
	const photosQuery = trpc.photos.useQuery();

	const scanMutation = trpc.scan.useMutation({
		onSuccess: (data) => {
			if (data.jobId) {
				setActiveJobId(data.jobId);
			}
			photosQuery.refetch();
		},
	});

	// Job progress tracking
	const jobProgress = useJobProgress(activeJobId);

	const photos = photosQuery.data?.photos ?? [];
	const loading = photosQuery.isLoading;

	// Library state for selection and view mode
	const library = useLibraryState(photos);


	// Group photos by date
	const sections = useMemo(() => groupPhotosByDate(photos), [photos]);

	// Handlers
	const handleScan = useCallback(() => {
		scanMutation.mutate();
	}, [scanMutation]);

	const handleRefresh = useCallback(() => {
		photosQuery.refetch();
	}, [photosQuery]);

	const handlePhotoPress = useCallback(
		(photo: PhotoMetadata) => {
			Haptics.selectionAsync();
			library.openInLoupe(photo);
		},
		[library],
	);

	const handlePhotoLongPress = useCallback(
		(photo: PhotoMetadata) => {
			Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
			library.selectPhoto(photo);
		},
		[library],
	);

	const handleLoupeClose = useCallback(() => {
		library.closeLoupe();
	}, [library]);

	const handleLoupeIndexChange = useCallback(
		(index: number) => {
			library.navigateToIndex(index);
		},
		[library],
	);

	const handleShowMetadata = useCallback((photo: PhotoMetadata) => {
		setMetadataPhoto(photo);
	}, []);

	const handleCloseMetadata = useCallback(() => {
		setMetadataPhoto(null);
	}, []);

	// Loading state
	if (loading && !library.isLoaded) {
		return (
			<View
				style={[styles.centerContainer, { backgroundColor: colors.background }]}
			>
				<ActivityIndicator size="large" color={colors.primary} />
				<Text style={[styles.loadingText, { color: colors.mutedForeground }]}>
					Loading photos...
				</Text>
			</View>
		);
	}

	// Grid view is always rendered so scroll position is preserved.
	// Loupe renders as a full-screen overlay on top (covering the tab bar).
	const showLoupe = library.viewMode === "loupe";

	const renderItem = ({ item }: { item: SectionItem }) => {
		if (item.type === "month-header") {
			return (
				<View style={styles.monthHeader}>
					<Text style={[styles.monthHeaderText, { color: colors.foreground }]}>
						{item.title}
					</Text>
				</View>
			);
		}

		if (item.type === "date-header") {
			return (
				<View style={styles.dateHeader}>
					<Text
						style={[styles.dateHeaderText, { color: colors.mutedForeground }]}
					>
						{item.title}
					</Text>
					<Pressable
						style={[
							styles.selectCircle,
							{ borderColor: colors.mutedForeground },
						]}
						onPress={() => {
							Haptics.selectionAsync();
						}}
					>
						<Ionicons
							name="checkmark"
							size={14}
							color={colors.mutedForeground}
							style={{ opacity: 0.4 }}
						/>
					</Pressable>
				</View>
			);
		}

		// photo-row
		const rowPhotos = item.photos;
		return (
			<View style={styles.photoRow}>
				{rowPhotos.map((photo) => {
					const isSelected = library.selectedPhotos.has(photo.id);
					return (
						<Pressable
							key={photo.id}
							onPress={() => handlePhotoPress(photo)}
							onLongPress={() => handlePhotoLongPress(photo)}
							style={[
								styles.photoContainer,
								{ backgroundColor: colors.muted },
							]}
						>
							<Image
								source={{
									uri: `${API_URL}/api/photos/${photo.id}/thumbnail/tiny`,
								}}
								style={styles.photo}
								contentFit="cover"
								transition={150}
								cachePolicy="memory-disk"
								placeholder={{ blurhash: "L6PZfSi_.AyE_3t7t7R**0o#DgR4" }}
							/>

							{/* RAW badge */}
							{photo.isRaw && (
								<View style={styles.rawBadge}>
									<Text style={styles.rawBadgeText}>
										{photo.rawFormat || "RAW"}
									</Text>
								</View>
							)}

							{/* Selection overlay */}
							{isSelected && (
								<View
									style={[
										styles.selectionOverlay,
										{ backgroundColor: `${colors.selection}30` },
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
				})}
				{/* Fill remaining space in incomplete rows */}
				{rowPhotos.length < COLUMNS &&
					Array.from({ length: COLUMNS - rowPhotos.length }).map((_, i) => (
						<View
							key={`spacer-${i}`}
							style={[styles.photoContainer, { backgroundColor: "transparent" }]}
						/>
					))}
			</View>
		);
	};

	// Empty state
	if (photos.length === 0 && !loading) {
		return (
			<View
				style={[styles.container, { backgroundColor: colors.background }]}
			>
				<ActivityBar
					progress={jobProgress.progress}
					isActive={jobProgress.isActive}
					isCompleted={jobProgress.isCompleted}
				/>
				<View style={styles.emptyContainer}>
					<Ionicons
						name="images-outline"
						size={64}
						color={colors.mutedForeground}
						style={{ opacity: 0.25 }}
					/>
					<Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
						No photos found
					</Text>
					<Text
						style={[styles.emptySubtext, { color: colors.mutedForeground }]}
					>
						Tap scan to import your photo library
					</Text>
					<Pressable
						style={[styles.emptyButton, { backgroundColor: colors.primary }]}
						onPress={handleScan}
						disabled={scanMutation.isPending || jobProgress.isActive}
					>
						{scanMutation.isPending || jobProgress.isActive ? (
							<ActivityIndicator size="small" color="#ffffff" />
						) : (
							<>
								<Ionicons name="scan-outline" size={20} color="#ffffff" />
								<Text style={styles.emptyButtonText}>Scan Photos</Text>
							</>
						)}
					</Pressable>
				</View>
			</View>
		);
	}

	return (
		<View style={[styles.container, { backgroundColor: colors.background }]}>
			{/* Activity/Progress bar */}
			<ActivityBar
				progress={jobProgress.progress}
				isActive={jobProgress.isActive}
				isCompleted={jobProgress.isCompleted}
			/>

			<FlatList
				data={sections}
				keyExtractor={(item) => item.key}
				renderItem={renderItem}
				contentContainerStyle={{ paddingTop: insets.top }}
				ListHeaderComponent={
					<View style={styles.appHeader}>
						<View style={styles.logoRow}>
							<View
								style={[
									styles.logoCircle,
									{ backgroundColor: colors.primary },
								]}
							>
								<Ionicons name="images" size={16} color="#ffffff" />
							</View>
							<Text style={[styles.logoText, { color: colors.foreground }]}>
								PhotoBrain
							</Text>
						</View>
						<View style={styles.headerActions}>
							<Pressable
								onPress={handleScan}
								disabled={scanMutation.isPending || jobProgress.isActive}
								style={[
									styles.headerButton,
									{ backgroundColor: colors.muted },
								]}
							>
								{scanMutation.isPending || jobProgress.isActive ? (
									<ActivityIndicator size="small" color={colors.foreground} />
								) : (
									<Ionicons
										name="sync-outline"
										size={20}
										color={colors.foreground}
									/>
								)}
							</Pressable>
							<View
								style={[
									styles.avatarCircle,
									{
										backgroundColor: colors.accent,
										borderColor: colors.border,
									},
								]}
							>
								<Ionicons
									name="person"
									size={18}
									color={colors.mutedForeground}
								/>
							</View>
						</View>
					</View>
				}
				refreshControl={
					<RefreshControl
						refreshing={photosQuery.isFetching}
						onRefresh={handleRefresh}
						tintColor={colors.primary}
					/>
				}
				initialNumToRender={15}
				maxToRenderPerBatch={10}
				windowSize={5}
				removeClippedSubviews
			/>

			{/* Loupe overlay — positioned over entire window including tab bar */}
			{showLoupe && (
				<View style={styles.loupeOverlay}>
					<LoupeView
						photos={photos}
						initialIndex={
							library.activePhotoIndex >= 0 ? library.activePhotoIndex : 0
						}
						apiUrl={API_URL}
						onClose={handleLoupeClose}
						onIndexChange={handleLoupeIndexChange}
						onShowMetadata={handleShowMetadata}
					/>
				</View>
			)}

			{/* Metadata panel */}
			<MetadataPanel
				visible={metadataPhoto !== null}
				photo={metadataPhoto}
				apiUrl={API_URL}
				onClose={handleCloseMetadata}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
	},
	loupeOverlay: {
		position: "absolute",
		top: 0,
		left: 0,
		width: SCREEN_WIDTH,
		height: SCREEN_HEIGHT,
		zIndex: 1000,
		elevation: 1000,
	},
	centerContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
	loadingText: {
		marginTop: 12,
		fontSize: 16,
	},
	appHeader: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		paddingHorizontal: 16,
		paddingTop: 4,
		paddingBottom: 8,
	},
	logoRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	logoCircle: {
		width: 32,
		height: 32,
		borderRadius: 16,
		justifyContent: "center",
		alignItems: "center",
	},
	logoText: {
		fontSize: 20,
		fontWeight: "800",
		letterSpacing: -0.3,
	},
	headerActions: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
	},
	headerButton: {
		width: 36,
		height: 36,
		borderRadius: 18,
		justifyContent: "center",
		alignItems: "center",
	},
	avatarCircle: {
		width: 36,
		height: 36,
		borderRadius: 18,
		justifyContent: "center",
		alignItems: "center",
		borderWidth: 1.5,
	},
	monthHeader: {
		paddingHorizontal: 16,
		paddingTop: 24,
		paddingBottom: 4,
	},
	monthHeaderText: {
		fontSize: 24,
		fontWeight: "700",
		letterSpacing: -0.3,
	},
	dateHeader: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		paddingHorizontal: 16,
		paddingTop: 12,
		paddingBottom: 6,
	},
	dateHeaderText: {
		fontSize: 14,
		fontWeight: "500",
	},
	selectCircle: {
		width: 24,
		height: 24,
		borderRadius: 12,
		borderWidth: 1.5,
		justifyContent: "center",
		alignItems: "center",
	},
	photoRow: {
		flexDirection: "row",
		gap: SPACING,
		marginBottom: SPACING,
	},
	photoContainer: {
		width: ITEM_SIZE,
		height: ITEM_SIZE,
		overflow: "hidden",
	},
	photo: {
		width: "100%",
		height: "100%",
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
	selectionOverlay: {
		...StyleSheet.absoluteFillObject,
		borderRadius: 0,
	},
	checkmark: {
		position: "absolute",
		bottom: 6,
		right: 6,
		width: 22,
		height: 22,
		borderRadius: 11,
		justifyContent: "center",
		alignItems: "center",
		borderWidth: 1.5,
		borderColor: "#ffffff",
	},
	emptyContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
		padding: 24,
		gap: 10,
	},
	emptyText: {
		fontSize: 18,
		fontWeight: "600",
	},
	emptySubtext: {
		fontSize: 14,
		textAlign: "center",
		marginBottom: 16,
	},
	emptyButton: {
		flexDirection: "row",
		alignItems: "center",
		paddingHorizontal: 24,
		paddingVertical: 12,
		borderRadius: 24,
		gap: 8,
	},
	emptyButtonText: {
		color: "#ffffff",
		fontSize: 16,
		fontWeight: "600",
	},
});
