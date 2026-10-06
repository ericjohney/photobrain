import { Ionicons } from "@expo/vector-icons";
import type { AppRouter } from "@photobrain/api";
import { parseDate } from "@photobrain/utils";
import { keepPreviousData } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	AppState,
	FlatList,
	type LayoutChangeEvent,
	Modal,
	type NativeScrollEvent,
	type NativeSyntheticEvent,
	Platform,
	Pressable,
	RefreshControl,
	StyleSheet,
	Text,
	useWindowDimensions,
	View,
	type ViewToken,
} from "react-native";
import {
	SafeAreaProvider,
	useSafeAreaInsets,
} from "react-native-safe-area-context";
import { z } from "zod";
import ActivityBar from "@/components/ActivityBar";
import FilterSheet, {
	EMPTY_FILTERS,
	formatDateMonth,
	type LibraryFilters,
	type LibraryGrouping,
	type LibrarySort,
} from "@/components/FilterSheet";
import LibraryHeader from "@/components/LibraryHeader";
import LibraryTimeScope from "@/components/LibraryTimeScope";
import LoupeView from "@/components/LoupeView";
import MetadataPanel from "@/components/MetadataPanel";
import { API_URL, API_V1_URL, thumbnailUrl } from "@/config";
import {
	SCAN_STALL_THRESHOLD_MS,
	useJobProgress,
} from "@/hooks/use-job-progress";
import { useLibraryState } from "@/hooks/use-library-state";
import { getActiveScanId, setActiveScanId } from "@/lib/preferences";
import { trpc } from "@/lib/trpc";
import { useTabBarVisibility } from "@/navigation/tab-bar-visibility";
import { useTheme } from "@/theme";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

type SectionItem =
	| {
			type: "header";
			level: "year" | "month";
			title: string;
			key: string;
	  }
	| { type: "photo-row"; photos: PhotoMetadata[]; key: string };

const GRID_SPACING = 1;
const V1_API_BASE_URL = API_V1_URL ?? `${API_URL.replace(/\/+$/, "")}/api/v1`;
const BROWSING_HISTORY_THRESHOLD = 24;
const SECTION_HEADER_HEIGHT = 57;

const ActiveScanSchema = z.object({
	id: z.string(),
	phase: z.string(),
	current: z.number(),
	total: z.number(),
	status: z.string(),
	error: z.string().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});
const ActiveScansSchema = z.object({ jobs: z.array(ActiveScanSchema) });
type ActiveScan = z.infer<typeof ActiveScanSchema>;

async function fetchActiveScans(): Promise<ActiveScan[]> {
	const response = await fetch(`${V1_API_BASE_URL}/scans/active`);
	if (!response.ok) throw new Error("Could not check active scans.");
	const jobs = ActiveScansSchema.parse(await response.json()).jobs;
	return jobs.sort((left, right) => {
		const updatedDifference =
			new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
		if (updatedDifference !== 0) return updatedDifference;
		const createdDifference =
			new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
		if (createdDifference !== 0) return createdDifference;
		if (right.id === left.id) return 0;
		return right.id > left.id ? 1 : -1;
	});
}

function scanIsStalled(scan: ActiveScan, now = Date.now()) {
	return (
		scan.phase === "queued" &&
		scan.status === "queued" &&
		now - new Date(scan.updatedAt).getTime() >= SCAN_STALL_THRESHOLD_MS
	);
}

function chooseActiveScan(
	jobs: ActiveScan[],
	preferredId: string | null,
): ActiveScan | null {
	const progressing = jobs.filter((job) => !scanIsStalled(job));
	const preferred = progressing.find((job) => job.id === preferredId);
	return preferred ?? progressing[0] ?? jobs[0] ?? null;
}

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
	const { colors, isDark } = useTheme();
	const insets = useSafeAreaInsets();
	const router = useRouter();
	const setTabBarHidden = useTabBarVisibility();
	const { width, fontScale } = useWindowDimensions();
	const columns = width >= 1024 ? 8 : width >= 768 ? 7 : width >= 560 ? 6 : 5;
	const itemSize = (width - GRID_SPACING * (columns - 1)) / columns;
	const [grouping, setGrouping] = useState<LibraryGrouping>("all");
	const [sort, setSort] = useState<LibrarySort>("captured");
	const [metadataPhoto, setMetadataPhoto] = useState<PhotoMetadata | null>(
		null,
	);
	const [isSelecting, setIsSelecting] = useState(false);
	const [selectedPhotoIds, setSelectedPhotoIds] = useState<ReadonlySet<number>>(
		() => new Set(),
	);
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	const activeJobIdRef = useRef<string | null>(null);
	const [selectedSnapshot, setSelectedSnapshot] = useState<ActiveScan | null>(
		null,
	);
	const activeSnapshotQueue = useRef<Promise<void>>(Promise.resolve());
	const latestSnapshotRequest = useRef(0);
	const restorationSourceReady = useRef(false);
	const snapshotLifecycle = useRef({ mounted: true });
	const migrationWriteQueue = useRef(Promise.resolve());
	const terminalReconciliation = useRef<string | null>(null);
	const queuedThresholdReconciliation = useRef<string | null>(null);
	const [isRestoringScan, setIsRestoringScan] = useState(true);
	const [submissionRecovery, setSubmissionRecovery] = useState<
		"settled" | "reconciling" | "ambiguous"
	>("settled");
	const [scanError, setScanError] = useState<string | null>(null);
	const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS);
	const [filterVisible, setFilterVisible] = useState(false);
	const [optionsPage, setOptionsPage] = useState<"options" | "filters">(
		"options",
	);
	const gridRef = useRef<FlatList<SectionItem>>(null);
	const [headerHeight, setHeaderHeight] = useState(0);
	const [isOverPhotos, setIsOverPhotos] = useState(false);
	const [isBrowsingHistory, setIsBrowsingHistory] = useState(false);
	const [timeScopeHeight, setTimeScopeHeight] = useState(0);
	const [visibleDate, setVisibleDate] = useState("");
	const [isVisible, setIsVisible] = useState(true);
	const browsingHistory = useRef(false);
	const groupingBeforeSelection = useRef<LibraryGrouping>("all");
	const scrollPosition = useRef(0);
	const contentHeaderHeight = useRef(0);
	const firstGroupHeight = useRef(0);
	const overPhotos = useRef(false);
	const visiblePhoto = useRef<PhotoMetadata | null>(null);
	const newestPhoto = useRef<PhotoMetadata | null>(null);
	const scrollToNewestPending = useRef(true);
	const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 1 }).current;

	const photosQuery = trpc.photos.useQuery(
		{
			camera: filters.camera ?? undefined,
			lens: filters.lens ?? undefined,
			iso: filters.iso ?? undefined,
			dateMonth: filters.dateMonth ?? undefined,
			filterRaw: filters.filterRaw ?? undefined,
		},
		{ placeholderData: keepPreviousData },
	);
	const filterOptionsQuery = trpc.filterOptions.useQuery({});
	const selectActiveJob = useCallback(
		(jobId: string | null, persist = true) => {
			activeJobIdRef.current = jobId;
			setActiveJobId(jobId);
			if (!persist) return;
			migrationWriteQueue.current = migrationWriteQueue.current
				.catch(() => undefined)
				.then(() => setActiveScanId(jobId))
				.catch(() => {
					setScanError(
						jobId
							? "Scan started, but progress recovery could not be saved."
							: "Could not clear the saved scan state.",
					);
				});
		},
		[],
	);
	const reconcileActiveScans = useCallback(
		(preferredId = activeJobIdRef.current) => {
			const request = ++latestSnapshotRequest.current;
			const previous = activeSnapshotQueue.current;
			const reconciliation = previous
				.catch(() => undefined)
				.then(async () => {
					try {
						const jobs = await fetchActiveScans();
						if (
							!snapshotLifecycle.current.mounted ||
							request !== latestSnapshotRequest.current
						) {
							return;
						}

						setSubmissionRecovery((current) =>
							current === "reconciling" ? "ambiguous" : current,
						);
						const selected = chooseActiveScan(jobs, preferredId);
						setSelectedSnapshot(selected);
						selectActiveJob(selected?.id ?? null);
					} catch {
						if (
							snapshotLifecycle.current.mounted &&
							request === latestSnapshotRequest.current
						) {
							setSubmissionRecovery((current) =>
								current === "reconciling" ? "ambiguous" : current,
							);
							setScanError("Could not check active scans.");
						}
					} finally {
						if (
							snapshotLifecycle.current.mounted &&
							restorationSourceReady.current &&
							request === latestSnapshotRequest.current
						) {
							setIsRestoringScan(false);
						}
					}
				});
			activeSnapshotQueue.current = reconciliation;
			return reconciliation;
		},
		[selectActiveJob],
	);
	const scanMutation = trpc.scan.useMutation({
		retry: false,
		onSuccess: (data) => {
			if (data.success && data.jobId) {
				setScanError(null);
				setSubmissionRecovery("settled");
				setSelectedSnapshot(null);
				selectActiveJob(data.jobId);
				void reconcileActiveScans(data.jobId);
				return;
			}
			if (!data.success) {
				setSubmissionRecovery("settled");
				setScanError(data.error ?? "The scan could not be started.");
				if (data.jobId) {
					void fetch(
						`${V1_API_BASE_URL}/scans/${encodeURIComponent(data.jobId)}`,
					).catch(() => undefined);
				}
			}
		},
		onError: (error) => {
			setScanError(error.message);
			setSubmissionRecovery("reconciling");
			void reconcileActiveScans();
		},
	});
	const jobProgress = useJobProgress(activeJobId);

	useEffect(() => {
		let cancelled = false;
		snapshotLifecycle.current.mounted = true;
		void (async () => {
			let preferredId: string | null = null;
			try {
				preferredId = await getActiveScanId();
			} catch {
				if (cancelled) return;
				setScanError("Could not restore the active scan.");
			}
			if (cancelled) return;
			if (preferredId) selectActiveJob(preferredId, false);
			restorationSourceReady.current = true;
			await reconcileActiveScans(preferredId);
		})();
		return () => {
			cancelled = true;
			snapshotLifecycle.current.mounted = false;
			latestSnapshotRequest.current++;
		};
	}, [reconcileActiveScans, selectActiveJob]);

	useEffect(() => {
		let previousState = AppState.currentState;
		const subscription = AppState.addEventListener("change", (nextState) => {
			if (
				(previousState === "background" || previousState === "inactive") &&
				nextState === "active"
			) {
				void reconcileActiveScans();
			}
			previousState = nextState;
		});
		return () => subscription.remove();
	}, [reconcileActiveScans]);

	useEffect(() => {
		if (
			!activeJobId ||
			(!jobProgress.isCompleted &&
				!jobProgress.isFailed &&
				!jobProgress.isMissingJob)
		) {
			return;
		}
		const reconciliationKey = `${activeJobId}:${jobProgress.progress?.phase}`;
		if (terminalReconciliation.current === reconciliationKey) return;
		terminalReconciliation.current = reconciliationKey;
		setSelectedSnapshot(null);
		selectActiveJob(null);
		void reconcileActiveScans(null);
	}, [
		activeJobId,
		jobProgress.isCompleted,
		jobProgress.isFailed,
		jobProgress.isMissingJob,
		jobProgress.progress?.phase,
		reconcileActiveScans,
		selectActiveJob,
	]);

	useEffect(() => {
		if (
			!activeJobId ||
			jobProgress.progress?.phase !== "queued" ||
			jobProgress.queuedStaleAt === null ||
			jobProgress.queuedStaleAt === undefined
		) {
			queuedThresholdReconciliation.current = null;
			return;
		}
		const reconciliationKey = `${activeJobId}:${jobProgress.queuedStaleAt}`;
		const reconcileOnce = () => {
			if (queuedThresholdReconciliation.current === reconciliationKey) return;
			queuedThresholdReconciliation.current = reconciliationKey;
			void reconcileActiveScans();
		};
		const remaining = jobProgress.queuedStaleAt - Date.now();
		if (remaining <= 0) {
			reconcileOnce();
			return;
		}
		const timeout = setTimeout(reconcileOnce, remaining);
		return () => clearTimeout(timeout);
	}, [
		activeJobId,
		jobProgress.progress?.phase,
		jobProgress.queuedStaleAt,
		reconcileActiveScans,
	]);

	const photos = useMemo(
		() =>
			[...(photosQuery.data?.photos ?? [])].sort((a, b) =>
				// IDs preserve library insertion order; createdAt is a filesystem date.
				sort === "added"
					? a.id - b.id
					: photoDate(a).getTime() - photoDate(b).getTime() || a.id - b.id,
			),
		[photosQuery.data?.photos, sort],
	);
	const library = useLibraryState(photos);
	const sections = useMemo(
		() => makeTimeline(photos, grouping, columns),
		[columns, grouping, photos],
	);
	const sectionLayouts = useMemo(() => {
		let offset = 0;
		return sections.map((item, index) => {
			const length =
				item.type === "header"
					? SECTION_HEADER_HEIGHT
					: itemSize + GRID_SPACING;
			const layout = { length, offset, index };
			offset += length;
			return layout;
		});
	}, [itemSize, sections]);
	const getSectionLayout = useCallback(
		(_data: ArrayLike<SectionItem> | null | undefined, index: number) =>
			sectionLayouts[index],
		[sectionLayouts],
	);
	const showTimeScope =
		photos.length > 0 &&
		!isSelecting &&
		(isBrowsingHistory || grouping !== "all");
	const timeScopeBottom = insets.bottom + 12;
	const gridBottomInset = showTimeScope
		? timeScopeBottom + timeScopeHeight + 12
		: insets.bottom + 12;
	const hasActiveFilters = Object.values(filters).some(
		(value) => value !== null,
	);
	const filterSummary = [
		filters.filterRaw === "raw"
			? "RAW"
			: filters.filterRaw === "standard"
				? "Standard"
				: null,
		filters.camera,
		filters.lens,
		filters.iso !== null ? `ISO ${filters.iso}` : null,
		filters.dateMonth ? formatDateMonth(filters.dateMonth) : null,
	].filter((value): value is string => value !== null);
	const selectedSnapshotIsStalled =
		selectedSnapshot?.id === activeJobId && scanIsStalled(selectedSnapshot);
	const stalledWorkRequiresConfirmation =
		selectedSnapshotIsStalled &&
		(jobProgress.isStalled ||
			Boolean(jobProgress.error) ||
			jobProgress.progress?.phase === null ||
			jobProgress.progress?.phase === undefined);
	const ambiguousSubmission = submissionRecovery === "ambiguous";
	const scanDisabled =
		isRestoringScan ||
		scanMutation.isPending ||
		submissionRecovery === "reconciling" ||
		(jobProgress.isActive && !stalledWorkRequiresConfirmation);
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
	const scrollContext = JSON.stringify([
		filters,
		grouping,
		sort,
		width,
		fontScale,
	]);
	const listContextKey = `${scrollContext}:${photos.length}:${photos[0]?.id ?? "empty"}:${photos.at(-1)?.id ?? "empty"}`;
	const photoContext = useMemo(
		() =>
			photos
				.map((photo) => `${photo.id}:${photoDate(photo).getTime()}`)
				.join(","),
		[photos],
	);
	const hasPhotos = useRef(photos.length > 0);
	newestPhoto.current = photos.at(-1) ?? null;
	hasPhotos.current = photos.length > 0;

	const updateOverPhotos = useCallback(() => {
		const next =
			hasPhotos.current &&
			scrollPosition.current >
				contentHeaderHeight.current + firstGroupHeight.current + 1;
		if (next !== overPhotos.current) {
			overPhotos.current = next;
			setIsOverPhotos(next);
		}
		if (next && !visiblePhoto.current && newestPhoto.current) {
			visiblePhoto.current = newestPhoto.current;
			setVisibleDate(
				photoDate(newestPhoto.current).toLocaleDateString(undefined, {
					month: "long",
					day: "numeric",
					year: "numeric",
				}),
			);
		}
	}, []);
	const handleScroll = useCallback(
		(event: NativeSyntheticEvent<NativeScrollEvent>) => {
			const { contentOffset, contentSize, layoutMeasurement } =
				event.nativeEvent;
			scrollPosition.current = contentOffset.y;
			updateOverPhotos();

			const distanceFromNewest = Math.max(
				0,
				contentSize.height - layoutMeasurement.height - contentOffset.y,
			);
			const nextBrowsingHistory =
				hasPhotos.current && distanceFromNewest > BROWSING_HISTORY_THRESHOLD;
			if (nextBrowsingHistory !== browsingHistory.current) {
				browsingHistory.current = nextBrowsingHistory;
				setIsBrowsingHistory(nextBrowsingHistory);
			}
		},
		[updateOverPhotos],
	);
	const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
		setHeaderHeight(event.nativeEvent.layout.height);
	}, []);
	const handleTimeScopeLayout = useCallback((event: LayoutChangeEvent) => {
		setTimeScopeHeight(event.nativeEvent.layout.height);
	}, []);
	const handleGridContentSizeChange = useCallback(
		(_width: number, height: number) => {
			if (!scrollToNewestPending.current || sections.length === 0) return;
			const list = gridRef.current;
			if (!list) return;
			const nativeScrollRef = list.getNativeScrollRef();
			if (
				Platform.OS === "web" &&
				nativeScrollRef &&
				"scrollTop" in nativeScrollRef &&
				typeof nativeScrollRef.scrollTop === "number"
			) {
				scrollToNewestPending.current = false;
				Reflect.set(nativeScrollRef, "scrollTop", height);
				if (
					"dispatchEvent" in nativeScrollRef &&
					typeof nativeScrollRef.dispatchEvent === "function"
				) {
					nativeScrollRef.dispatchEvent(new Event("scroll", { bubbles: true }));
				}
				return;
			}
			scrollToNewestPending.current = false;
			list.scrollToOffset({ offset: height, animated: false });
		},
		[sections.length],
	);
	const handleContentHeaderLayout = useCallback(
		(event: LayoutChangeEvent) => {
			contentHeaderHeight.current = event.nativeEvent.layout.height;
			updateOverPhotos();
		},
		[updateOverPhotos],
	);
	const handleFirstGroupLayout = useCallback(
		(event: LayoutChangeEvent) => {
			firstGroupHeight.current = event.nativeEvent.layout.height;
			updateOverPhotos();
		},
		[updateOverPhotos],
	);
	const handleViewableItemsChanged = useCallback(
		({ viewableItems }: { viewableItems: ViewToken<SectionItem>[] }) => {
			const row = viewableItems.find(
				(token) => token.isViewable && token.item.type === "photo-row",
			)?.item;
			const photo = row?.type === "photo-row" ? row.photos[0] : null;
			if (!photo || visiblePhoto.current === photo) return;
			visiblePhoto.current = photo;
			const date = photoDate(photo).toLocaleDateString(undefined, {
				month: "long",
				day: "numeric",
				year: "numeric",
			});
			setVisibleDate((current) => (current === date ? current : date));
		},
		[],
	);

	useEffect(() => {
		// A changed library context opens on its newest photo, matching iOS Photos.
		void scrollContext;
		void photoContext;
		scrollPosition.current = 0;
		overPhotos.current = false;
		browsingHistory.current = false;
		visiblePhoto.current = null;
		scrollToNewestPending.current = true;
		if (grouping === "all") firstGroupHeight.current = 0;
		setIsOverPhotos(false);
		setIsBrowsingHistory(false);
		setVisibleDate("");
	}, [grouping, photoContext, scrollContext]);
	useEffect(() => {
		if (sections.length === 0) return;
		const timeout = setTimeout(() => {
			if (!scrollToNewestPending.current) return;
			const list = gridRef.current;
			if (!list) return;
			const nativeScrollRef = list.getNativeScrollRef();
			if (
				Platform.OS === "web" &&
				nativeScrollRef &&
				"scrollHeight" in nativeScrollRef &&
				typeof nativeScrollRef.scrollHeight === "number" &&
				"scrollTop" in nativeScrollRef &&
				typeof nativeScrollRef.scrollTop === "number"
			) {
				scrollToNewestPending.current = false;
				Reflect.set(nativeScrollRef, "scrollTop", nativeScrollRef.scrollHeight);
				if (
					"dispatchEvent" in nativeScrollRef &&
					typeof nativeScrollRef.dispatchEvent === "function"
				) {
					nativeScrollRef.dispatchEvent(new Event("scroll", { bubbles: true }));
				}
				return;
			}
			scrollToNewestPending.current = false;
			list.scrollToEnd({ animated: false });
		}, 0);
		return () => clearTimeout(timeout);
	}, [sections]);

	useEffect(() => {
		setTabBarHidden(isVisible && showTimeScope);
	}, [isVisible, setTabBarHidden, showTimeScope]);

	useEffect(
		() => () => {
			setTabBarHidden(false);
		},
		[setTabBarHidden],
	);

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
		void Promise.all([
			photosQuery.refetch(),
			filterOptionsQuery.refetch(),
			reconcileActiveScans(),
		]);
	}, [filterOptionsQuery, photosQuery, reconcileActiveScans]);
	const submitScan = useCallback(
		(input?: { force: true }) => {
			const submit = () => {
				setScanError(null);
				setSubmissionRecovery("settled");
				if (input) scanMutation.mutate(input);
				else scanMutation.mutate();
			};
			if (!stalledWorkRequiresConfirmation && !ambiguousSubmission) {
				submit();
				return;
			}
			Alert.alert(
				"Start another scan?",
				ambiguousSubmission
					? "The previous scan request may have reached the server, but its status could not be confirmed. Starting another scan may duplicate work. Continue only if you know the earlier request will not resume."
					: "The existing scan has not made progress for at least five minutes. Starting another scan may duplicate work. Continue only if you know the earlier scan will not resume.",
				[
					{ text: "Cancel", style: "cancel" },
					{ text: "Start another scan", onPress: submit },
				],
			);
		},
		[ambiguousSubmission, scanMutation, stalledWorkRequiresConfirmation],
	);
	const handleScan = useCallback(() => {
		if (scanDisabled) return;
		submitScan();
	}, [scanDisabled, submitScan]);
	const handleReprocess = () => {
		if (scanDisabled) return;
		Alert.alert(
			"Reprocess all photos?",
			"This regenerates thumbnails and search embeddings for every photo. Original files are left untouched. This takes longer than a normal library scan.",
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Reprocess all photos",
					onPress: () => {
						setFilterVisible(false);
						submitScan({ force: true });
					},
				},
			],
		);
	};
	const handleFilterChange = useCallback((nextFilters: LibraryFilters) => {
		setFilters(nextFilters);
		setIsSelecting(false);
		setSelectedPhotoIds(new Set());
	}, []);
	const handleGroupingChange = (nextGrouping: LibraryGrouping) => {
		setGrouping(nextGrouping);
		if (nextGrouping !== "all") setSort("captured");
	};
	const openOptions = (page: "options" | "filters") => {
		setOptionsPage(page);
		setFilterVisible(true);
	};
	const togglePhotoSelection = useCallback((photoId: number) => {
		setSelectedPhotoIds((current) => {
			const next = new Set(current);
			if (next.has(photoId)) next.delete(photoId);
			else next.add(photoId);
			return next;
		});
	}, []);
	const toggleSelectionMode = useCallback(() => {
		if (isSelecting) {
			setSelectedPhotoIds(new Set());
			setGrouping(groupingBeforeSelection.current);
		} else {
			groupingBeforeSelection.current = grouping;
		}
		setIsSelecting(!isSelecting);
	}, [grouping, isSelecting]);

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
					onLayout={item === sections[0] ? handleFirstGroupLayout : undefined}
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
		<View onLayout={handleContentHeaderLayout}>
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
				<View
					style={[
						styles.filterSummary,
						{ backgroundColor: colors.selectionMuted },
					]}
				>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Edit active filters"
						accessibilityValue={{ text: filterSummary.join(", ") }}
						onPress={() => openOptions("filters")}
						style={styles.filterSummaryButton}
					>
						<Ionicons name="funnel" size={16} color={colors.primary} />
						<Text
							numberOfLines={2}
							style={[styles.filterSummaryText, { color: colors.primary }]}
						>
							{filterSummary.join(", ")}
						</Text>
						<Ionicons name="chevron-forward" size={14} color={colors.primary} />
					</Pressable>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Show all items"
						onPress={() => handleFilterChange(EMPTY_FILTERS)}
						style={styles.dismissButton}
					>
						<Ionicons name="close-circle" size={22} color={colors.primary} />
					</Pressable>
				</View>
			)}
		</View>
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

	return (
		<View style={[styles.container, { backgroundColor: colors.background }]}>
			<NativeTabs.Trigger
				unstable_nativeProps={{
					onWillAppear: () => setIsVisible(true),
					onWillDisappear: () => setIsVisible(false),
				}}
			/>
			{isVisible && (
				<ExpoStatusBar style={isOverPhotos || isDark ? "light" : "dark"} />
			)}
			<FlatList
				key={listContextKey}
				ref={gridRef}
				testID="library-grid"
				onScroll={handleScroll}
				onContentSizeChange={handleGridContentSizeChange}
				scrollEventThrottle={16}
				onViewableItemsChanged={handleViewableItemsChanged}
				viewabilityConfig={viewabilityConfig}
				data={sections}
				getItemLayout={getSectionLayout}
				keyExtractor={(item) => item.key}
				renderItem={renderItem}
				ListHeaderComponent={listHeader}
				ListEmptyComponent={
					photosQuery.isLoading ? (
						<View style={styles.emptyContainer}>
							<ActivityIndicator size="large" color={colors.primary} />
						</View>
					) : photosQuery.isError && !photosQuery.data && !hasActiveFilters ? (
						<View style={styles.emptyContainer}>
							<Ionicons
								name="cloud-offline-outline"
								size={48}
								color={colors.mutedForeground}
							/>
							<Text style={[styles.errorTitle, { color: colors.foreground }]}>
								Couldn't Load Library
							</Text>
							<Text
								style={[styles.errorMessage, { color: colors.mutedForeground }]}
							>
								Check your connection to the PhotoBrain server and try again.
							</Text>
							<Pressable
								accessibilityRole="button"
								onPress={handleRefresh}
								style={[
									styles.emptyButton,
									{ backgroundColor: colors.primary },
								]}
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
					) : (
						emptyState
					)
				}
				contentContainerStyle={[
					sections.length === 0 && styles.emptyList,
					{ paddingTop: headerHeight, paddingBottom: gridBottomInset },
				]}
				contentInsetAdjustmentBehavior="never"
				scrollIndicatorInsets={{ top: headerHeight, bottom: gridBottomInset }}
				refreshControl={
					<RefreshControl
						refreshing={photosQuery.isFetching}
						onRefresh={handleRefresh}
						progressViewOffset={headerHeight}
						tintColor={colors.primary}
					/>
				}
				initialNumToRender={18}
				maxToRenderPerBatch={12}
				windowSize={7}
				removeClippedSubviews
			/>
			<LibraryHeader
				subtitle={
					isSelecting
						? selectionLabel
						: isBrowsingHistory && visibleDate
							? visibleDate
							: itemCountLabel
				}
				isOverPhotos={isOverPhotos}
				isSelecting={isSelecting}
				selectionDisabled={photos.length === 0}
				hasActiveFilters={hasActiveFilters}
				onOptions={() => openOptions("options")}
				onToggleSelection={toggleSelectionMode}
				onLayout={handleHeaderLayout}
			/>
			{(jobProgress.isActive ||
				jobProgress.isCompleted ||
				jobProgress.isFailed) && (
				<View
					pointerEvents="none"
					style={[
						styles.activityOverlay,
						{
							bottom: showTimeScope
								? timeScopeBottom + timeScopeHeight + 12
								: insets.bottom + 72,
							left: insets.left + 12,
							right: insets.right + 12,
						},
					]}
				>
					<ActivityBar
						progress={jobProgress.progress}
						isActive={jobProgress.isActive}
						isCompleted={jobProgress.isCompleted}
						isFailed={jobProgress.isFailed}
						failureMessage={jobProgress.failureMessage}
						error={jobProgress.error}
					/>
				</View>
			)}
			{showTimeScope && (
				<View
					pointerEvents="box-none"
					style={[
						styles.timeScopeOverlay,
						{
							bottom: timeScopeBottom,
							left: insets.left + 16,
							right: insets.right + 16,
						},
					]}
				>
					<LibraryTimeScope
						grouping={grouping}
						onGroupingChange={handleGroupingChange}
						onShowCollections={() => router.push("/collections")}
						onShowSearch={() => router.push("/search")}
						onLayout={handleTimeScopeLayout}
					/>
				</View>
			)}

			<Modal
				visible={library.viewMode === "loupe"}
				animationType="none"
				statusBarTranslucent
				supportedOrientations={["portrait", "landscape"]}
				onRequestClose={library.closeLoupe}
			>
				{library.viewMode === "loupe" && <ExpoStatusBar style="light" />}
				<SafeAreaProvider style={styles.loupeRoot}>
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
				</SafeAreaProvider>
			</Modal>

			<FilterSheet
				visible={filterVisible}
				initialPage={optionsPage}
				onClose={() => setFilterVisible(false)}
				filterOptions={filterOptionsQuery.data}
				isLoadingFilters={filterOptionsQuery.isLoading}
				filtersError={filterOptionsQuery.isError}
				onRetryFilters={() => {
					void filterOptionsQuery.refetch();
				}}
				activeFilters={filters}
				onFilterChange={handleFilterChange}
				sort={sort}
				onSortChange={(nextSort) => {
					setSort(nextSort);
					if (nextSort === "added") setGrouping("all");
				}}
				onScan={() => {
					setFilterVisible(false);
					handleScan();
				}}
				onReprocess={handleReprocess}
				scanDisabled={scanDisabled}
				isScanning={
					scanMutation.isPending ||
					submissionRecovery === "reconciling" ||
					(jobProgress.isActive && !stalledWorkRequiresConfirmation)
				}
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
	loupeRoot: { flex: 1 },
	timeScopeOverlay: { position: "absolute" },
	activityOverlay: {
		position: "absolute",
		zIndex: 10,
	},
	filterSummary: {
		minHeight: 44,
		alignSelf: "stretch",
		flexDirection: "row",
		alignItems: "center",
		gap: 7,
		marginVertical: 9,
		marginHorizontal: 16,
		borderRadius: 16,
		paddingHorizontal: 12,
	},
	filterSummaryButton: {
		flex: 1,
		minHeight: 44,
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingVertical: 8,
	},
	filterSummaryText: { flex: 1, fontSize: 14, fontWeight: "600" },
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
	sectionHeader: {
		height: SECTION_HEADER_HEIGHT,
		paddingHorizontal: 16,
		paddingTop: 22,
		paddingBottom: 7,
	},
	sectionHeaderText: {
		fontSize: 23,
		lineHeight: 28,
		fontWeight: "700",
		letterSpacing: -0.45,
	},
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
