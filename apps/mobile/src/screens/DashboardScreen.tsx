import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import { parseDate } from "@photobrain/utils";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { keepPreviousData } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	FlatList,
	Modal,
	Pressable,
	RefreshControl,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ActivityBar from "@/components/ActivityBar";
import FilterSheet, { type LibraryGrouping } from "@/components/FilterSheet";
import GlassSurface from "@/components/GlassSurface";
import LoupeView from "@/components/LoupeView";
import MetadataPanel from "@/components/MetadataPanel";
import { thumbnailUrl } from "@/config";
import { useJobProgress } from "@/hooks/use-job-progress";
import { useLibraryState } from "@/hooks/use-library-state";
import { trpc } from "@/lib/trpc";
import { useTheme } from "@/theme";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

interface Filters {
	camera: string | null;
	lens: string | null;
	iso: number | null;
	dateMonth: string | null;
}

type SectionItem =
	| {
			type: "header";
			level: "year" | "month";
			title: string;
			key: string;
	  }
	| { type: "photo-row"; photos: PhotoMetadata[]; key: string };

const GRID_SPACING = 1;
const ACTIVE_SCAN_KEY = "@photobrain/active-scan";
const EMPTY_FILTERS: Filters = {
	camera: null,
	lens: null,
	iso: null,
	dateMonth: null,
};

function photoDate(photo: PhotoMetadata) {
	return parseDate(
		photo.exif?.dateTaken ?? photo.modifiedAt ?? photo.createdAt,
	);
}

function makeTimeline(
	photos: PhotoMetadata[],
	scope: LibraryGrouping,
	columns: number,
): SectionItem[] {
	const items: SectionItem[] = [];
	let lastYear = "";
	let lastMonth = "";
	let row: PhotoMetadata[] = [];

	const flushRow = () => {
		if (row.length === 0) return;
		items.push({
			type: "photo-row",
			photos: row,
			key: `row-${row[0].id}`,
		});
		row = [];
	};

	for (const photo of photos) {
		const date = photoDate(photo);
		const year = date.toLocaleDateString(undefined, { year: "numeric" });
		const month = date.toLocaleDateString(undefined, {
			year: "numeric",
			month: "long",
		});
		if (scope === "years" && year !== lastYear) {
			flushRow();
			items.push({
				type: "header",
				level: "year",
				title: year,
				key: `year-${year}`,
			});
			lastYear = year;
		} else if (scope === "months" && month !== lastMonth) {
			flushRow();
			items.push({
				type: "header",
				level: "month",
				title: month,
				key: `month-${month}`,
			});
			lastMonth = month;
		}

		row.push(photo);
		if (row.length === columns) flushRow();
	}

	flushRow();
	return items;
}

export default function DashboardScreen() {
	const { colors } = useTheme();
	const insets = useSafeAreaInsets();
	const router = useRouter();
	const { width, fontScale } = useWindowDimensions();
	const columns = width >= 1024 ? 8 : width >= 768 ? 7 : width >= 560 ? 6 : 5;
	const itemSize = (width - GRID_SPACING * (columns - 1)) / columns;
	const [grouping, setGrouping] = useState<LibraryGrouping>("all");
	const [metadataPhoto, setMetadataPhoto] = useState<PhotoMetadata | null>(
		null,
	);
	const [isSelecting, setIsSelecting] = useState(false);
	const [selectedPhotoIds, setSelectedPhotoIds] = useState<ReadonlySet<number>>(
		() => new Set(),
	);
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	const activeJobSelected = useRef(false);
	const [isRestoringScan, setIsRestoringScan] = useState(true);
	const [scanError, setScanError] = useState<string | null>(null);
	const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
	const [filterVisible, setFilterVisible] = useState(false);

	const photosQuery = trpc.photos.useQuery(
		{
			camera: filters.camera ?? undefined,
			lens: filters.lens ?? undefined,
			iso: filters.iso ?? undefined,
			dateMonth: filters.dateMonth ?? undefined,
		},
		{ placeholderData: keepPreviousData },
	);
	const filterOptionsQuery = trpc.filterOptions.useQuery({});
	const scanMutation = trpc.scan.useMutation({
		onSuccess: (data) => {
			if (data.success && data.jobId) {
				activeJobSelected.current = true;
				setScanError(null);
				setActiveJobId(data.jobId);
				void AsyncStorage.setItem(ACTIVE_SCAN_KEY, data.jobId).catch(() => {
					setScanError(
						"Scan started, but progress recovery could not be saved.",
					);
				});
			} else if (!data.success) {
				setScanError(data.error ?? "The scan could not be started.");
			}
		},
		onError: (error) => setScanError(error.message),
	});
	const jobProgress = useJobProgress(activeJobId);

	useEffect(() => {
		let cancelled = false;
		void AsyncStorage.getItem(ACTIVE_SCAN_KEY)
			.then((jobId) => {
				if (!cancelled && jobId && !activeJobSelected.current) {
					setActiveJobId(jobId);
				}
			})
			.catch(() => {
				if (!cancelled) setScanError("Could not restore the active scan.");
			})
			.finally(() => {
				if (!cancelled) setIsRestoringScan(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (jobProgress.isCompleted || jobProgress.isFailed) {
			void AsyncStorage.removeItem(ACTIVE_SCAN_KEY).catch(() => {
				setScanError("Could not clear the saved scan state.");
			});
		}
	}, [jobProgress.isCompleted, jobProgress.isFailed]);

	const photos = useMemo(
		() =>
			[...(photosQuery.data?.photos ?? [])].sort(
				(a, b) => photoDate(b).getTime() - photoDate(a).getTime(),
			),
		[photosQuery.data?.photos],
	);
	const library = useLibraryState(photos);
	const sections = useMemo(
		() => makeTimeline(photos, grouping, columns),
		[columns, grouping, photos],
	);
	const hasActiveFilters = Object.values(filters).some(
		(value) => value !== null,
	);
	const scanDisabled =
		isRestoringScan || scanMutation.isPending || jobProgress.isActive;
	const filteredQueryFailed =
		photosQuery.isError && !photosQuery.data && hasActiveFilters;
	const itemCount = photosQuery.data?.total ?? photos.length;
	const itemCountLabel = filteredQueryFailed
		? "Items Unavailable"
		: `${itemCount.toLocaleString()} ${itemCount === 1 ? "Item" : "Items"}`;
	const selectionLabel =
		selectedPhotoIds.size === 0
			? "Select Items"
			: `${selectedPhotoIds.size.toLocaleString()} Selected`;
	const headerPhoto = photos[0];

	useEffect(() => {
		if (!isSelecting) return;
		if (photos.length === 0) {
			setSelectedPhotoIds(new Set());
			setIsSelecting(false);
			return;
		}
		const availableIds = new Set(photos.map((photo) => photo.id));
		setSelectedPhotoIds((current) => {
			const next = new Set(
				[...current].filter((photoId) => availableIds.has(photoId)),
			);
			return next.size === current.size ? current : next;
		});
	}, [isSelecting, photos]);

	const handleRefresh = useCallback(() => {
		void Promise.all([photosQuery.refetch(), filterOptionsQuery.refetch()]);
	}, [filterOptionsQuery, photosQuery]);
	const handleScan = useCallback(() => {
		setScanError(null);
		scanMutation.mutate();
	}, [scanMutation]);
	const handleFilterChange = useCallback((nextFilters: Filters) => {
		setFilters(nextFilters);
		setIsSelecting(false);
		setSelectedPhotoIds(new Set());
	}, []);
	const togglePhotoSelection = useCallback((photoId: number) => {
		setSelectedPhotoIds((current) => {
			const next = new Set(current);
			if (next.has(photoId)) next.delete(photoId);
			else next.add(photoId);
			return next;
		});
	}, []);
	const toggleSelectionMode = useCallback(() => {
		if (isSelecting) setSelectedPhotoIds(new Set());
		setIsSelecting(!isSelecting);
	}, [isSelecting]);

	const handlePhotoPress = useCallback(
		(photo: PhotoMetadata) => {
			if (isSelecting) {
				togglePhotoSelection(photo.id);
				return;
			}
			library.openInLoupe(photo);
		},
		[isSelecting, library, togglePhotoSelection],
	);
	const handlePhotoLongPress = useCallback((photoId: number) => {
		setIsSelecting(true);
		setSelectedPhotoIds((current) => {
			if (current.has(photoId)) return current;
			return new Set([...current, photoId]);
		});
	}, []);

	const renderItem = ({ item }: { item: SectionItem }) => {
		if (item.type === "header") {
			return (
				<View
					style={[styles.sectionHeader, { backgroundColor: colors.background }]}
				>
					<Text
						style={[styles.sectionHeaderText, { color: colors.foreground }]}
					>
						{item.title}
					</Text>
				</View>
			);
		}

		return (
			<View style={styles.photoRow}>
				{item.photos.map((photo) => {
					const selected = selectedPhotoIds.has(photo.id);
					return (
						<Pressable
							key={photo.id}
							testID={`photo-thumbnail-${photo.id}`}
							accessibilityRole="button"
							accessibilityLabel={
								isSelecting
									? `${selected ? "Deselect" : "Select"} ${photo.name}`
									: `Open ${photo.name}`
							}
							accessibilityState={isSelecting ? { selected } : undefined}
							onPress={() => handlePhotoPress(photo)}
							onLongPress={() => handlePhotoLongPress(photo.id)}
							style={[
								styles.photoContainer,
								{
									width: itemSize,
									height: itemSize,
									backgroundColor: colors.muted,
								},
							]}
						>
							<Image
								source={{
									uri: thumbnailUrl(
										photo.id,
										"small",
										photo.thumbnailUpdatedAt,
									),
								}}
								style={styles.photo}
								contentFit="cover"
								transition={120}
								cachePolicy="memory-disk"
								accessibilityIgnoresInvertColors
							/>
							{photo.isRaw && (
								<View style={styles.rawBadge}>
									<Text style={styles.rawBadgeText}>
										{photo.rawFormat || "RAW"}
									</Text>
								</View>
							)}
							{isSelecting && (
								<View
									pointerEvents="none"
									style={[
										styles.selectionOverlay,
										selected && styles.selectionOverlayActive,
									]}
								>
									<View
										style={[
											styles.selectionIndicator,
											selected && styles.selectionIndicatorActive,
										]}
									>
										{selected && (
											<Ionicons name="checkmark" size={15} color="#ffffff" />
										)}
									</View>
								</View>
							)}
						</Pressable>
					);
				})}
			</View>
		);
	};

	const listHeader = (
		<>
			<View style={[styles.header, { paddingTop: insets.top + 8 }]}>
				<View pointerEvents="none" style={styles.headerBackdrop}>
					{headerPhoto && (
						<Image
							testID="library-header-image"
							source={{
								uri: thumbnailUrl(
									headerPhoto.id,
									"medium",
									headerPhoto.thumbnailUpdatedAt,
								),
							}}
							style={styles.headerBackdropPhoto}
							contentFit="cover"
							blurRadius={16}
							cachePolicy="memory-disk"
							accessibilityIgnoresInvertColors
						/>
					)}
					<View style={styles.headerBackdropShade} />
				</View>
				<View
					style={[styles.titleRow, fontScale > 1.3 && styles.titleRowStacked]}
				>
					<View style={styles.titleBlock}>
						<Text style={styles.title}>Library</Text>
						<Text style={styles.photoCount}>
							{isSelecting ? selectionLabel : itemCountLabel}
						</Text>
					</View>
					<View style={styles.headerActions}>
						<GlassSurface
							style={styles.optionsButtonSurface}
							fallbackStyle={styles.darkGlassFallback}
							glassEffectStyle="clear"
							tintColor="rgba(28,28,30,0.48)"
							colorScheme="dark"
							isInteractive
						>
							<Pressable
								accessibilityRole="button"
								accessibilityLabel={
									hasActiveFilters
										? "Library options, filters active"
										: "Library options"
								}
								onPress={() => setFilterVisible(true)}
								style={styles.headerButton}
							>
								<Ionicons
									name="options-outline"
									size={27}
									color={hasActiveFilters ? "#64a8ff" : "#ffffff"}
								/>
							</Pressable>
						</GlassSurface>
						<GlassSurface
							style={styles.selectButtonSurface}
							fallbackStyle={styles.darkGlassFallback}
							glassEffectStyle="clear"
							tintColor="rgba(28,28,30,0.48)"
							colorScheme="dark"
							isInteractive
						>
							<Pressable
								accessibilityRole="button"
								accessibilityState={{ disabled: photos.length === 0 }}
								accessibilityLabel={
									isSelecting ? "Finish selecting photos" : "Select photos"
								}
								disabled={photos.length === 0}
								onPress={toggleSelectionMode}
								style={[
									styles.selectButton,
									photos.length === 0 && styles.disabledButton,
								]}
							>
								<Text style={styles.selectButtonText}>
									{isSelecting ? "Done" : "Select"}
								</Text>
							</Pressable>
						</GlassSurface>
					</View>
				</View>
			</View>
			<ActivityBar
				progress={jobProgress.progress}
				isActive={jobProgress.isActive}
				isCompleted={jobProgress.isCompleted}
				isFailed={jobProgress.isFailed}
				failureMessage={jobProgress.failureMessage}
				error={jobProgress.error}
			/>
			{scanError && (
				<View
					accessibilityRole="alert"
					style={[
						styles.errorBanner,
						{ backgroundColor: colors.destructiveMuted },
					]}
				>
					<Ionicons name="alert-circle" size={18} color={colors.destructive} />
					<Text style={[styles.errorBannerText, { color: colors.destructive }]}>
						{scanError}
					</Text>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Dismiss scan error"
						style={styles.dismissButton}
						onPress={() => setScanError(null)}
					>
						<Ionicons name="close" size={18} color={colors.destructive} />
					</Pressable>
				</View>
			)}
			{hasActiveFilters && (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Edit active filters"
					onPress={() => setFilterVisible(true)}
					style={[
						styles.filterSummary,
						{ backgroundColor: colors.selectionMuted },
					]}
				>
					<Ionicons name="funnel" size={14} color={colors.primary} />
					<Text style={[styles.filterSummaryText, { color: colors.primary }]}>
						Filters active
					</Text>
					<Text style={[styles.filterSummaryAction, { color: colors.primary }]}>
						Edit
					</Text>
				</Pressable>
			)}
		</>
	);

	const emptyState = (
		<View style={styles.emptyContainer}>
			<Ionicons
				name={
					filteredQueryFailed
						? "cloud-offline-outline"
						: hasActiveFilters
							? "options-outline"
							: "images-outline"
				}
				size={50}
				color={colors.mutedForeground}
				style={styles.emptyIcon}
			/>
			<Text style={[styles.emptyTitle, { color: colors.foreground }]}>
				{filteredQueryFailed
					? "Couldn't update library"
					: hasActiveFilters
						? "No photos match your filters"
						: "Your library is empty"}
			</Text>
			<Text style={[styles.emptyMessage, { color: colors.mutedForeground }]}>
				{filteredQueryFailed
					? "Check your connection, retry, or clear the active filters."
					: hasActiveFilters
						? "Adjust or clear the filters to see your library."
						: "Scan the configured PhotoBrain library to get started."}
			</Text>
			<View style={styles.emptyActions}>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={
						filteredQueryFailed ? "Retry filtered library" : undefined
					}
					disabled={!hasActiveFilters && scanDisabled}
					onPress={() => {
						if (filteredQueryFailed) void photosQuery.refetch();
						else if (hasActiveFilters) handleFilterChange(EMPTY_FILTERS);
						else handleScan();
					}}
					style={[styles.emptyButton, { backgroundColor: colors.primary }]}
				>
					{!hasActiveFilters && scanDisabled ? (
						<ActivityIndicator size="small" color={colors.primaryForeground} />
					) : (
						<Ionicons
							name={
								filteredQueryFailed
									? "refresh"
									: hasActiveFilters
										? "close"
										: "sync-outline"
							}
							size={18}
							color={colors.primaryForeground}
						/>
					)}
					<Text
						style={[
							styles.emptyButtonText,
							{ color: colors.primaryForeground },
						]}
					>
						{filteredQueryFailed
							? "Try Again"
							: hasActiveFilters
								? "Clear Filters"
								: "Scan Library"}
					</Text>
				</Pressable>
				{filteredQueryFailed && (
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Clear filters"
						onPress={() => handleFilterChange(EMPTY_FILTERS)}
						style={[
							styles.secondaryEmptyButton,
							{ borderColor: colors.border },
						]}
					>
						<Text
							style={[
								styles.secondaryEmptyButtonText,
								{ color: colors.primary },
							]}
						>
							Clear Filters
						</Text>
					</Pressable>
				)}
			</View>
		</View>
	);

	if (photosQuery.isLoading) {
		return (
			<View style={[styles.loading, { backgroundColor: colors.background }]}>
				<ActivityIndicator size="large" color={colors.primary} />
			</View>
		);
	}

	if (photosQuery.isError && !photosQuery.data && !hasActiveFilters) {
		return (
			<View
				style={[
					styles.loading,
					{ backgroundColor: colors.background, paddingTop: insets.top },
				]}
			>
				<Ionicons
					name="cloud-offline-outline"
					size={48}
					color={colors.mutedForeground}
				/>
				<Text style={[styles.errorTitle, { color: colors.foreground }]}>
					Couldn't Load Library
				</Text>
				<Text style={[styles.errorMessage, { color: colors.mutedForeground }]}>
					Check your connection to the PhotoBrain server and try again.
				</Text>
				<Pressable
					accessibilityRole="button"
					onPress={handleRefresh}
					style={[styles.emptyButton, { backgroundColor: colors.primary }]}
				>
					<Text
						style={[
							styles.emptyButtonText,
							{ color: colors.primaryForeground },
						]}
					>
						Try Again
					</Text>
				</Pressable>
			</View>
		);
	}

	return (
		<View
			style={[
				styles.container,
				{ backgroundColor: photos.length > 0 ? "#000000" : colors.background },
			]}
		>
			<FlatList
				style={photos.length > 0 ? styles.photoList : undefined}
				data={sections}
				keyExtractor={(item) => item.key}
				renderItem={renderItem}
				ListHeaderComponent={listHeader}
				ListEmptyComponent={emptyState}
				contentContainerStyle={[
					sections.length === 0 && styles.emptyList,
					{ paddingBottom: insets.bottom + 86 },
				]}
				contentInsetAdjustmentBehavior="never"
				refreshControl={
					<RefreshControl
						refreshing={photosQuery.isFetching}
						onRefresh={handleRefresh}
						tintColor={colors.primary}
					/>
				}
				initialNumToRender={18}
				maxToRenderPerBatch={12}
				windowSize={7}
				removeClippedSubviews
			/>
			{isSelecting && (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Finish selection"
					onPress={toggleSelectionMode}
					style={[styles.selectionExit, { bottom: insets.bottom + 90 }]}
				>
					<Text style={styles.selectButtonText}>Done selecting</Text>
				</Pressable>
			)}

			<Modal
				visible={library.viewMode === "loupe"}
				animationType="none"
				statusBarTranslucent
				supportedOrientations={["portrait", "landscape"]}
				onRequestClose={library.closeLoupe}
			>
				<ExpoStatusBar style="light" />
				<View style={styles.loupeRoot}>
					<LoupeView
						key={library.loupeSession}
						photos={photos}
						initialIndex={Math.max(library.activePhotoIndex, 0)}
						onClose={library.closeLoupe}
						onIndexChange={library.navigateToIndex}
						onShowMetadata={setMetadataPhoto}
					/>
					<MetadataPanel
						visible={metadataPhoto !== null}
						photo={metadataPhoto}
						onClose={() => setMetadataPhoto(null)}
					/>
				</View>
			</Modal>

			<FilterSheet
				visible={filterVisible}
				onClose={() => setFilterVisible(false)}
				filterOptions={filterOptionsQuery.data}
				isLoadingFilters={filterOptionsQuery.isLoading}
				filtersError={filterOptionsQuery.isError}
				onRetryFilters={() => {
					void filterOptionsQuery.refetch();
				}}
				activeFilters={filters}
				onFilterChange={handleFilterChange}
				grouping={grouping}
				onGroupingChange={setGrouping}
				onScan={() => {
					setFilterVisible(false);
					handleScan();
				}}
				scanDisabled={scanDisabled}
				isScanning={scanMutation.isPending || jobProgress.isActive}
				onOpenSettings={() => {
					setFilterVisible(false);
					setIsSelecting(false);
					setSelectedPhotoIds(new Set());
					router.push("/preferences");
				}}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	photoList: { backgroundColor: "#000000" },
	loupeRoot: { flex: 1 },
	loading: { flex: 1, alignItems: "center", justifyContent: "center" },
	header: {
		position: "relative",
		minHeight: 150,
		justifyContent: "flex-end",
		paddingHorizontal: 20,
		paddingBottom: 13,
		backgroundColor: "#161616",
		overflow: "hidden",
	},
	headerBackdrop: {
		...StyleSheet.absoluteFill,
	},
	headerBackdropPhoto: {
		...StyleSheet.absoluteFill,
		transform: [{ scale: 1.08 }],
	},
	headerBackdropShade: {
		...StyleSheet.absoluteFill,
		backgroundColor: "rgba(0,0,0,0.52)",
	},
	titleRow: {
		flexDirection: "row",
		alignItems: "flex-end",
		justifyContent: "space-between",
		gap: 12,
	},
	titleBlock: { flex: 1, minWidth: 0, gap: 1 },
	titleRowStacked: { flexDirection: "column", alignItems: "stretch" },
	title: {
		color: "#ffffff",
		fontSize: 36,
		fontWeight: "700",
		letterSpacing: -1.25,
	},
	photoCount: {
		color: "rgba(255,255,255,0.92)",
		fontSize: 16,
		fontWeight: "700",
		letterSpacing: -0.15,
	},
	headerActions: {
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingBottom: 2,
	},
	darkGlassFallback: {
		backgroundColor: "#343436",
		borderColor: "rgba(255,255,255,0.16)",
		borderWidth: StyleSheet.hairlineWidth,
	},
	optionsButtonSurface: {
		width: 50,
		height: 50,
		borderRadius: 25,
		borderCurve: "continuous",
		overflow: "hidden",
	},
	headerButton: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
	},
	selectButtonSurface: {
		minWidth: 88,
		height: 50,
		borderRadius: 25,
		borderCurve: "continuous",
		overflow: "hidden",
	},
	selectButton: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 18,
	},
	disabledButton: { opacity: 0.45 },
	selectButtonText: { color: "#ffffff", fontSize: 17, fontWeight: "600" },
	selectionExit: {
		position: "absolute",
		alignSelf: "center",
		minHeight: 44,
		paddingHorizontal: 20,
		paddingVertical: 12,
		borderRadius: 24,
		backgroundColor: "#343436",
		borderColor: "#636366",
		borderWidth: StyleSheet.hairlineWidth,
		justifyContent: "center",
	},
	filterSummary: {
		minHeight: 44,
		alignSelf: "center",
		flexDirection: "row",
		alignItems: "center",
		gap: 7,
		marginVertical: 9,
		borderRadius: 16,
		paddingHorizontal: 12,
		paddingVertical: 7,
	},
	filterSummaryText: { fontSize: 13, fontWeight: "600" },
	filterSummaryAction: { fontSize: 13, fontWeight: "700", marginLeft: 4 },
	errorBanner: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginHorizontal: 12,
		marginVertical: 9,
		paddingHorizontal: 12,
		paddingVertical: 10,
		borderRadius: 14,
	},
	errorBannerText: { flex: 1, fontSize: 13, fontWeight: "500" },
	dismissButton: {
		width: 44,
		height: 44,
		alignItems: "center",
		justifyContent: "center",
	},
	errorTitle: { marginTop: 16, fontSize: 21, fontWeight: "700" },
	errorMessage: {
		marginTop: 7,
		maxWidth: 310,
		fontSize: 14,
		lineHeight: 20,
		textAlign: "center",
	},
	sectionHeader: { paddingHorizontal: 16, paddingTop: 22, paddingBottom: 7 },
	sectionHeaderText: { fontSize: 23, fontWeight: "700", letterSpacing: -0.45 },
	photoRow: {
		flexDirection: "row",
		gap: GRID_SPACING,
		marginBottom: GRID_SPACING,
	},
	photoContainer: { overflow: "hidden" },
	photo: { width: "100%", height: "100%" },
	selectionOverlay: {
		...StyleSheet.absoluteFill,
		alignItems: "flex-end",
		padding: 7,
		backgroundColor: "rgba(0,0,0,0.1)",
	},
	selectionOverlayActive: {
		backgroundColor: "rgba(0,0,0,0.28)",
	},
	selectionIndicator: {
		width: 24,
		height: 24,
		borderRadius: 12,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: "rgba(0,0,0,0.34)",
		borderColor: "rgba(255,255,255,0.9)",
		borderWidth: 1.5,
	},
	selectionIndicatorActive: {
		backgroundColor: "#0a84ff",
		borderColor: "#ffffff",
	},
	rawBadge: {
		position: "absolute",
		top: 4,
		left: 4,
		backgroundColor: "rgba(0,0,0,0.72)",
		paddingHorizontal: 5,
		paddingVertical: 2,
		borderRadius: 4,
	},
	rawBadgeText: { color: "#ffffff", fontSize: 9, fontWeight: "700" },
	emptyList: { flexGrow: 1 },
	emptyContainer: {
		flex: 1,
		minHeight: 360,
		alignItems: "center",
		justifyContent: "center",
		padding: 32,
	},
	emptyIcon: { opacity: 0.38, marginBottom: 16 },
	emptyTitle: { fontSize: 20, fontWeight: "700", textAlign: "center" },
	emptyMessage: {
		marginTop: 6,
		fontSize: 14,
		lineHeight: 20,
		textAlign: "center",
		maxWidth: 300,
	},
	emptyButton: {
		flexDirection: "row",
		alignItems: "center",
		gap: 7,
		borderRadius: 20,
		paddingHorizontal: 18,
		paddingVertical: 10,
	},
	emptyButtonText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
	emptyActions: { marginTop: 20, alignItems: "center", gap: 10 },
	secondaryEmptyButton: {
		minHeight: 42,
		justifyContent: "center",
		borderWidth: StyleSheet.hairlineWidth,
		borderRadius: 21,
		paddingHorizontal: 18,
	},
	secondaryEmptyButtonText: { fontSize: 15, fontWeight: "600" },
});
