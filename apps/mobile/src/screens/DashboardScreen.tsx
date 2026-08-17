import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import { parseDate } from "@photobrain/utils";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { inferRouterOutputs } from "@trpc/server";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
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
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ActivityBar from "@/components/ActivityBar";
import FilterSheet from "@/components/FilterSheet";
import GlassSurface from "@/components/GlassSurface";
import LoupeView from "@/components/LoupeView";
import MetadataPanel from "@/components/MetadataPanel";
import { thumbnailUrl } from "@/config";
import { useJobProgress } from "@/hooks/use-job-progress";
import { useLibraryState } from "@/hooks/use-library-state";
import { trpc } from "@/lib/trpc";
import { useColors } from "@/theme";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];
type TimelineScope = "years" | "months" | "all";

interface Filters {
	camera: string | null;
	lens: string | null;
	iso: number | null;
	dateMonth: string | null;
}

type SectionItem =
	| {
			type: "header";
			level: "year" | "month" | "day";
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
	scope: TimelineScope,
	columns: number,
): SectionItem[] {
	const items: SectionItem[] = [];
	let lastYear = "";
	let lastMonth = "";
	let lastDay = "";
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
		const day = date.toLocaleDateString(undefined, {
			weekday: "short",
			month: "short",
			day: "numeric",
			year: "numeric",
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
		} else if (scope !== "years" && month !== lastMonth) {
			flushRow();
			items.push({
				type: "header",
				level: "month",
				title: month,
				key: `month-${month}`,
			});
			lastMonth = month;
			lastDay = "";
		}

		if (scope === "all" && day !== lastDay) {
			flushRow();
			items.push({
				type: "header",
				level: "day",
				title: day,
				key: `day-${day}`,
			});
			lastDay = day;
		}

		row.push(photo);
		if (row.length === columns) flushRow();
	}

	flushRow();
	return items;
}

function TimelinePicker({
	value,
	onChange,
}: {
	value: TimelineScope;
	onChange: (scope: TimelineScope) => void;
}) {
	const colors = useColors();
	const options: Array<{ value: TimelineScope; label: string }> = [
		{ value: "years", label: "Years" },
		{ value: "months", label: "Months" },
		{ value: "all", label: "All Photos" },
	];

	return (
		<GlassSurface style={styles.timelinePicker} glassEffectStyle="clear">
			{options.map((option) => {
				const selected = option.value === value;
				return (
					<Pressable
						key={option.value}
						accessibilityRole="tab"
						accessibilityState={{ selected }}
						onPress={() => onChange(option.value)}
						style={[
							styles.timelineOption,
							selected && { backgroundColor: colors.foreground },
						]}
					>
						<Text
							style={[
								styles.timelineLabel,
								{ color: selected ? colors.background : colors.foreground },
							]}
						>
							{option.label}
						</Text>
					</Pressable>
				);
			})}
		</GlassSurface>
	);
}

export default function DashboardScreen() {
	const colors = useColors();
	const insets = useSafeAreaInsets();
	const router = useRouter();
	const { width } = useWindowDimensions();
	const columns = width >= 1024 ? 8 : width >= 768 ? 7 : width >= 560 ? 5 : 4;
	const itemSize = (width - GRID_SPACING * (columns - 1)) / columns;
	const [scope, setScope] = useState<TimelineScope>("all");
	const [metadataPhoto, setMetadataPhoto] = useState<PhotoMetadata | null>(
		null,
	);
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	const activeJobSelected = useRef(false);
	const [isRestoringScan, setIsRestoringScan] = useState(true);
	const [scanError, setScanError] = useState<string | null>(null);
	const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
	const [filterVisible, setFilterVisible] = useState(false);

	const photosQuery = trpc.photos.useQuery({
		camera: filters.camera ?? undefined,
		lens: filters.lens ?? undefined,
		iso: filters.iso ?? undefined,
		dateMonth: filters.dateMonth ?? undefined,
	});
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
		() => makeTimeline(photos, scope, columns),
		[columns, photos, scope],
	);
	const hasActiveFilters = Object.values(filters).some(
		(value) => value !== null,
	);
	const scanDisabled =
		isRestoringScan || scanMutation.isPending || jobProgress.isActive;

	const handleRefresh = useCallback(() => {
		void Promise.all([photosQuery.refetch(), filterOptionsQuery.refetch()]);
	}, [filterOptionsQuery, photosQuery]);
	const handleScan = useCallback(() => {
		setScanError(null);
		scanMutation.mutate();
	}, [scanMutation]);

	const handlePhotoPress = useCallback(
		(photo: PhotoMetadata) => {
			void Haptics.selectionAsync();
			library.openInLoupe(photo);
		},
		[library],
	);

	const renderItem = ({ item }: { item: SectionItem }) => {
		if (item.type === "header") {
			return (
				<View
					style={[
						styles.sectionHeader,
						item.level === "day" && styles.dayHeader,
					]}
				>
					<Text
						style={[
							item.level === "day"
								? styles.dayHeaderText
								: styles.sectionHeaderText,
							{
								color:
									item.level === "day"
										? colors.mutedForeground
										: colors.foreground,
							},
						]}
					>
						{item.title}
					</Text>
				</View>
			);
		}

		return (
			<View style={styles.photoRow}>
				{item.photos.map((photo) => (
					<Pressable
						key={photo.id}
						testID={`photo-thumbnail-${photo.id}`}
						accessibilityRole="button"
						accessibilityLabel={`Open ${photo.name}`}
						onPress={() => handlePhotoPress(photo)}
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
								uri: thumbnailUrl(photo.id, "tiny", photo.thumbnailUpdatedAt),
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
					</Pressable>
				))}
			</View>
		);
	};

	const listHeader = (
		<View style={[styles.header, { paddingTop: insets.top + 10 }]}>
			<ActivityBar
				progress={jobProgress.progress}
				isActive={jobProgress.isActive}
				isCompleted={jobProgress.isCompleted}
				isFailed={jobProgress.isFailed}
				failureMessage={jobProgress.failureMessage}
			/>
			<View style={styles.titleRow}>
				<View style={styles.titleBlock}>
					<Text style={[styles.title, { color: colors.foreground }]}>
						Library
					</Text>
					<Text style={[styles.photoCount, { color: colors.mutedForeground }]}>
						{photosQuery.data?.total ?? photos.length}{" "}
						{(photosQuery.data?.total ?? photos.length) === 1
							? "Photo"
							: "Photos"}
					</Text>
				</View>
				<GlassSurface style={styles.headerActions} glassEffectStyle="clear">
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Filter photos"
						onPress={() => setFilterVisible(true)}
						style={styles.headerButton}
					>
						<Ionicons
							name={hasActiveFilters ? "funnel" : "funnel-outline"}
							size={20}
							color={hasActiveFilters ? colors.primary : colors.foreground}
						/>
					</Pressable>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Scan library"
						disabled={scanDisabled}
						onPress={handleScan}
						style={styles.headerButton}
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
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Open settings"
						onPress={() => router.push("/preferences")}
						style={styles.headerButton}
					>
						<Ionicons
							name="person-circle-outline"
							size={23}
							color={colors.foreground}
						/>
					</Pressable>
				</GlassSurface>
			</View>
			<TimelinePicker value={scope} onChange={setScope} />
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
						onPress={() => setScanError(null)}
					>
						<Ionicons name="close" size={18} color={colors.destructive} />
					</Pressable>
				</View>
			)}
			{hasActiveFilters && (
				<Pressable
					accessibilityRole="button"
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
		</View>
	);

	const emptyState = (
		<View style={styles.emptyContainer}>
			<Ionicons
				name={hasActiveFilters ? "options-outline" : "images-outline"}
				size={50}
				color={colors.mutedForeground}
				style={styles.emptyIcon}
			/>
			<Text style={[styles.emptyTitle, { color: colors.foreground }]}>
				{hasActiveFilters
					? "No photos match your filters"
					: "Your library is empty"}
			</Text>
			<Text style={[styles.emptyMessage, { color: colors.mutedForeground }]}>
				{hasActiveFilters
					? "Adjust or clear the filters to see your library."
					: "Scan the configured PhotoBrain library to get started."}
			</Text>
			<Pressable
				accessibilityRole="button"
				disabled={!hasActiveFilters && scanDisabled}
				onPress={() =>
					hasActiveFilters ? setFilters(EMPTY_FILTERS) : handleScan()
				}
				style={[styles.emptyButton, { backgroundColor: colors.primary }]}
			>
				{!hasActiveFilters && scanDisabled ? (
					<ActivityIndicator size="small" color="#ffffff" />
				) : (
					<Ionicons
						name={hasActiveFilters ? "close" : "sync-outline"}
						size={18}
						color="#ffffff"
					/>
				)}
				<Text style={styles.emptyButtonText}>
					{hasActiveFilters ? "Clear Filters" : "Scan Library"}
				</Text>
			</Pressable>
		</View>
	);

	if (photosQuery.isLoading) {
		return (
			<View style={[styles.loading, { backgroundColor: colors.background }]}>
				<ActivityIndicator size="large" color={colors.primary} />
			</View>
		);
	}

	if (photosQuery.isError && !photosQuery.data) {
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
					<Text style={styles.emptyButtonText}>Try Again</Text>
				</Pressable>
			</View>
		);
	}

	return (
		<View style={[styles.container, { backgroundColor: colors.background }]}>
			<FlatList
				data={sections}
				keyExtractor={(item) => item.key}
				renderItem={renderItem}
				ListHeaderComponent={listHeader}
				ListEmptyComponent={emptyState}
				contentContainerStyle={
					sections.length === 0 ? styles.emptyList : undefined
				}
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

			<Modal
				visible={library.viewMode === "loupe"}
				animationType="none"
				statusBarTranslucent
				supportedOrientations={["portrait", "landscape"]}
				onRequestClose={library.closeLoupe}
			>
				<GestureHandlerRootView style={styles.loupeRoot}>
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
				</GestureHandlerRootView>
			</Modal>

			<FilterSheet
				visible={filterVisible}
				onClose={() => setFilterVisible(false)}
				filterOptions={filterOptionsQuery.data}
				activeFilters={filters}
				onFilterChange={setFilters}
			/>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1 },
	loupeRoot: { flex: 1 },
	loading: { flex: 1, alignItems: "center", justifyContent: "center" },
	header: { paddingHorizontal: 16, paddingBottom: 12, gap: 14 },
	titleRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
	},
	titleBlock: { gap: 1 },
	title: { fontSize: 34, fontWeight: "700", letterSpacing: -1.1 },
	photoCount: { fontSize: 13, fontWeight: "500" },
	headerActions: {
		flexDirection: "row",
		alignItems: "center",
		borderRadius: 24,
		borderCurve: "continuous",
		overflow: "hidden",
	},
	headerButton: {
		width: 42,
		height: 42,
		alignItems: "center",
		justifyContent: "center",
	},
	timelinePicker: {
		alignSelf: "center",
		flexDirection: "row",
		padding: 3,
		borderRadius: 20,
		borderCurve: "continuous",
	},
	timelineOption: {
		paddingHorizontal: 15,
		paddingVertical: 7,
		borderRadius: 17,
		borderCurve: "continuous",
	},
	timelineLabel: { fontSize: 13, fontWeight: "600" },
	filterSummary: {
		alignSelf: "center",
		flexDirection: "row",
		alignItems: "center",
		gap: 7,
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
		paddingHorizontal: 12,
		paddingVertical: 10,
		borderRadius: 14,
	},
	errorBannerText: { flex: 1, fontSize: 13, fontWeight: "500" },
	errorTitle: { marginTop: 16, fontSize: 21, fontWeight: "700" },
	errorMessage: {
		marginTop: 7,
		maxWidth: 310,
		fontSize: 14,
		lineHeight: 20,
		textAlign: "center",
	},
	sectionHeader: { paddingHorizontal: 16, paddingTop: 22, paddingBottom: 7 },
	dayHeader: { paddingTop: 10, paddingBottom: 5 },
	sectionHeaderText: { fontSize: 23, fontWeight: "700", letterSpacing: -0.45 },
	dayHeaderText: { fontSize: 13, fontWeight: "600" },
	photoRow: {
		flexDirection: "row",
		gap: GRID_SPACING,
		marginBottom: GRID_SPACING,
	},
	photoContainer: { overflow: "hidden" },
	photo: { width: "100%", height: "100%" },
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
		marginTop: 20,
		flexDirection: "row",
		alignItems: "center",
		gap: 7,
		borderRadius: 20,
		paddingHorizontal: 18,
		paddingVertical: 10,
	},
	emptyButtonText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
});
