import {
	Copy,
	Layers,
	ListFilter,
	ScanEye,
	Search,
	Sparkles,
	UserRound,
} from "lucide-react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { DuplicateGroupList } from "@/components/DuplicateGroupList";
import { DuplicatesHeader } from "@/components/DuplicatesHeader";
import { Filmstrip } from "@/components/Filmstrip";
import { GearStatsView } from "@/components/GearStatsView";
import { LoupeView } from "@/components/LoupeView";
import type { MapFocus } from "@/components/MapView";
import { OnThisDayStrip } from "@/components/OnThisDayStrip";
import { PeopleView } from "@/components/PeopleView";
import { PhotoGrid } from "@/components/PhotoGrid";
import { ActivityPanel } from "@/components/panels/ActivityPanel";
import { AppSidebar } from "@/components/panels/AppSidebar";
import { MetadataPanel } from "@/components/panels/MetadataPanel";
import { faceRowId } from "@/components/panels/PhotoPeople";
import { PanelLayout } from "@/components/panels/PanelLayout";
import { ReviewHeader } from "@/components/ReviewHeader";
import { SaveSmartAlbumSheet } from "@/components/SaveSmartAlbumSheet";
import { AppHeader, type Crumb } from "@/components/AppHeader";
import { StatusBar, type StatusMode } from "@/components/StatusBar";
import {
	EMPTY_LIBRARY_FILTERS,
	FLAG_FILTER_LABELS,
	type LibraryFilters,
	minRatingLabel,
} from "@/lib/library-filters";
import { UploadDropZone } from "@/components/UploadDropZone";
import { Button } from "@/components/ui/button";
import { RemovableChip } from "@/components/ui/chip";
import { EmptyState, Spinner } from "@/components/ui/empty-state";
import { ViewHeader } from "@/components/ui/view-header";
import { useCollections } from "@/hooks/use-collections";
import { useDuplicateGroups } from "@/hooks/use-duplicate-groups";
import { useJobProgress } from "@/hooks/use-job-progress";
import { useJunkReview } from "@/hooks/use-junk-review";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import {
	useLibraryState,
	useTimelineSettings,
	type ViewMode,
} from "@/hooks/use-library-state";
import { useOnThisDay } from "@/hooks/use-on-this-day";
import { usePanelState } from "@/hooks/use-panel-state";
import { personName, usePeople } from "@/hooks/use-people";
import {
	type CurationPatch,
	usePhotoCuration,
} from "@/hooks/use-photo-curation";
import {
	fromSmartAlbumFilters,
	smartAlbumMatches,
	toSmartAlbumFilters,
	useSmartAlbums,
} from "@/hooks/use-smart-albums";
import { useUploads } from "@/hooks/use-uploads";
import { eventTitle } from "@/lib/events";
import { downloadUrl, exportFileName } from "@/lib/export";
import { JUNK_REASON_LABELS } from "@/lib/junk-review";
import { photoLocation } from "@/lib/map";
import { formatCapturedDate } from "@/lib/on-this-day";
import { exportPhotoUrl } from "@/lib/thumbnails";
import { countCapturedDays, groupPhotos } from "@/lib/timeline";
import { trpc } from "@/lib/trpc";
import type {
	DuplicateKind,
	EventSummary,
	JunkAction,
	JunkReason,
	PhotoBounds,
	PhotoFace,
	PhotoMetadata,
	PhotoPlace,
	SmartAlbum,
} from "@/lib/types";
import { formatMonthLabel } from "@/lib/utils";

// MapLibre is large; load it only when the map view is first opened.
const MapView = lazy(() => import("@/components/MapView"));

export function Dashboard() {
	const [searchQuery, setSearchQuery] = useState("");
	// Source photo of "More like this" mode; null when browsing the library/search.
	const [similarSource, setSimilarSource] = useState<PhotoMetadata | null>(
		null,
	);
	const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
	// Mutually exclusive with selectedFolder; null with no folder = All Photos.
	const [selectedCollectionId, setSelectedCollectionId] = useState<
		number | null
	>(null);
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	// Review, Duplicates, and People replace the library view; folder,
	// collection, and filters are kept (but ignored) so leaving them restores
	// the library.
	const [catalogView, setCatalogView] = useState<
		"review" | "duplicates" | "people" | null
	>(null);
	const reviewActive = catalogView === "review";
	const duplicatesActive = catalogView === "duplicates";
	const peopleActive = catalogView === "people";
	const [showHiddenPeople, setShowHiddenPeople] = useState(false);
	const [reviewReason, setReviewReason] = useState<JunkReason | null>(null);
	const [duplicateKind, setDuplicateKind] = useState<DuplicateKind | null>(
		null,
	);
	const [filters, setFilters] = useState<LibraryFilters>(EMPTY_LIBRARY_FILTERS);
	// The smart album last applied. Any later change to the folder, filters,
	// search, or mode deselects it: the album is a starting point, not a lock.
	const [appliedSmartAlbumId, setAppliedSmartAlbumId] = useState<number | null>(
		null,
	);
	const [savingSmartAlbum, setSavingSmartAlbum] = useState(false);
	// The API defaults filterRaw to "all"; omit it from requests in that case.
	const filterRaw = filters.filterRaw === "all" ? undefined : filters.filterRaw;
	const collectionId = selectedCollectionId ?? undefined;

	const smartAlbumsApi = useSmartAlbums();
	const currentSmartAlbumFilters = toSmartAlbumFilters(selectedFolder, filters);
	const currentSmartAlbumQuery = searchQuery.trim() || null;
	const appliedSmartAlbum =
		appliedSmartAlbumId === null
			? undefined
			: smartAlbumsApi.albums?.find((a) => a.id === appliedSmartAlbumId);
	const selectedSmartAlbum =
		appliedSmartAlbum &&
		selectedCollectionId === null &&
		catalogView === null &&
		similarSource === null &&
		// A map area, capture date, or event narrows the album, so it no longer
		// shows exactly the album.
		filters.bounds === null &&
		filters.capturedDate === null &&
		filters.event === null &&
		smartAlbumMatches(
			appliedSmartAlbum,
			currentSmartAlbumFilters,
			currentSmartAlbumQuery,
		)
			? appliedSmartAlbum
			: null;
	// Deselect for good once anything diverges (re-entering the same filters
	// does not reselect), or once the album is gone from a loaded list.
	const albumsLoaded = smartAlbumsApi.albums !== undefined;
	useEffect(() => {
		if (appliedSmartAlbumId !== null && albumsLoaded && !selectedSmartAlbum) {
			setAppliedSmartAlbumId(null);
		}
	}, [appliedSmartAlbumId, albumsLoaded, selectedSmartAlbum]);
	// Collection scope, map area, capture date, and event are never saved, so
	// any of them alone is not savable; with other filters they are left out.
	const canSaveSmartAlbum =
		Object.keys(currentSmartAlbumFilters).length > 0 ||
		currentSmartAlbumQuery !== null;

	// tRPC queries
	const foldersQuery = trpc.folders.useQuery();

	const filterOptionsQuery = trpc.filterOptions.useQuery({
		folder: selectedFolder ?? undefined,
	});
	// Events are listed for the folder scope, like the filter options.
	const eventsQuery = trpc.events.useQuery({
		folder: selectedFolder ?? undefined,
	});

	// Library scope shared by the grid, search, and the map (minus bounds).
	const libraryScope = {
		folder: selectedFolder ?? undefined,
		collectionId,
		filterRaw,
		camera: filters.camera ?? undefined,
		lens: filters.lens ?? undefined,
		iso: filters.iso ?? undefined,
		dateMonth: filters.dateMonth ?? undefined,
		minRating: filters.minRating ?? undefined,
		flag: filters.flag ?? undefined,
		tag: filters.tag ?? undefined,
		country: filters.country ?? undefined,
		place: filters.place ?? undefined,
		personId: filters.personId ?? undefined,
		capturedDate: filters.capturedDate ?? undefined,
		event: filters.event?.id,
	};
	const bounds = filters.bounds ?? undefined;

	const photosInput = { ...libraryScope, bounds };
	const photosQuery = trpc.photos.useQuery(photosInput, {
		enabled: !searchQuery && catalogView === null,
	});

	// Search is scoped by the same folder and EXIF filters as the library.
	const searchPhotosQuery = trpc.searchPhotos.useQuery(
		{
			query: searchQuery,
			// An opened query smart album uses the API's maximum, like other clients.
			limit: selectedSmartAlbum ? 100 : 50,
			...libraryScope,
			bounds,
		},
		{ enabled: !!searchQuery && catalogView === null },
	);

	const similarPhotosQuery = trpc.similarPhotos.useQuery(
		{ photoId: similarSource?.id ?? 0, limit: 60, event: filters.event?.id },
		{ enabled: similarSource !== null },
	);

	const review = useJunkReview({ active: reviewActive, reason: reviewReason });
	const duplicates = useDuplicateGroups({
		active: duplicatesActive,
		kind: duplicateKind,
	});
	const peopleApi = usePeople({
		active: peopleActive,
		includeHidden: showHiddenPeople,
	});
	// The scoped person's name for the header, chip, and search scope.
	const scopedPersonQuery = trpc.person.useQuery(
		{ id: filters.personId ?? 0 },
		{ enabled: filters.personId !== null },
	);
	const personScopeLabel =
		filters.personId === null
			? null
			: `Person: ${scopedPersonQuery.data ? personName(scopedPersonQuery.data) : "…"}`;
	// Loupe/filmstrip navigation in Duplicates walks every shown member once.
	const duplicatePhotos = useMemo(() => {
		const seen = new Set<number>();
		return duplicates.groups
			.flatMap((group) => group.photos)
			.filter((photo) => !seen.has(photo.id) && seen.add(photo.id));
	}, [duplicates.groups]);
	const collectionsApi = useCollections();
	const selectedCollection =
		selectedCollectionId === null
			? null
			: (collectionsApi.collections?.find(
					(c) => c.id === selectedCollectionId,
				) ?? null);

	// Inngest-based async scan
	const scanMutation = trpc.scan.useMutation({
		onSuccess: (data) => {
			if (data.success && data.jobId) {
				setActiveJobId(data.jobId);
			}
		},
		onError: (error) => {
			console.error("Scan failed:", error);
		},
	});

	// Job progress tracking via Inngest Realtime
	const jobProgress = useJobProgress(activeJobId);
	const scanDisabled = scanMutation.isPending || jobProgress.isActive;
	// The upload import scan is tracked like a manual one once it starts.
	const uploads = useUploads({
		currentJobId: activeJobId,
		onImportJob: setActiveJobId,
	});

	// Determine which data to use
	const activeQuery = reviewActive
		? review.listQuery
		: similarSource
			? similarPhotosQuery
			: searchQuery
				? searchPhotosQuery
				: photosQuery;
	const listedPhotos: PhotoMetadata[] = peopleActive
		? []
		: duplicatesActive
			? duplicatePhotos
			: (activeQuery.data?.photos ?? []);
	const loading = peopleActive
		? false
		: duplicatesActive
			? duplicates.listQuery.isLoading
			: activeQuery.isLoading;
	const error = peopleActive
		? null
		: duplicatesActive
			? duplicates.listQuery.error
			: activeQuery.error;
	const similarNotIndexed =
		similarSource !== null && similarPhotosQuery.data?.indexed === false;

	// Timeline: only the library listing is sorted and grouped; search and
	// similar results keep their ranking, Review and Duplicates their order.
	const timelineSettings = useTimelineSettings();
	const libraryListed =
		catalogView === null && similarSource === null && !searchQuery;
	const timeline = useMemo(
		() =>
			libraryListed
				? groupPhotos(
						listedPhotos,
						timelineSettings.grouping,
						timelineSettings.sort,
					)
				: { photos: listedPhotos, sections: null },
		[
			libraryListed,
			listedPhotos,
			timelineSettings.grouping,
			timelineSettings.sort,
		],
	);
	// The displayed order: what the grid, loupe, filmstrip, and arrows walk.
	const photos = timeline.photos;
	// Calendar counts come from the loaded (already filtered) library list.
	const calendarCounts = useMemo(
		() => countCapturedDays(libraryListed ? listedPhotos : []),
		[libraryListed, listedPhotos],
	);

	// State management hooks
	const library = useLibraryState(photos);
	const panels = usePanelState();
	const mapActive = library.viewMode === "map";

	// "Gear" replaces the library grid (never search, similar, Review, or
	// Duplicates) with stats over exactly the grid's photo set.
	const [gearActive, setGearActive] = useState(false);
	const libraryGrid = libraryListed && library.viewMode === "grid";
	const gearShown = gearActive && libraryGrid;
	useEffect(() => {
		if (!libraryGrid) setGearActive(false);
	}, [libraryGrid]);
	const gearStatsQuery = trpc.gearStats.useQuery(photosInput, {
		enabled: gearShown,
	});

	// Map: every geotagged photo in the library scope (folder/collection and
	// filters, not the search query or the current map area).
	const photoLocationsQuery = trpc.photoLocations.useQuery(libraryScope, {
		enabled: mapActive,
	});

	// "On this day" shows only over the whole, unscoped library grid.
	const wholeLibraryShown =
		Object.keys(currentSmartAlbumFilters).length === 0 &&
		filters.capturedDate === null &&
		filters.event === null &&
		filters.bounds === null &&
		!searchQuery &&
		selectedCollectionId === null &&
		catalogView === null &&
		similarSource === null &&
		!gearShown;
	const onThisDay = useOnThisDay(wholeLibraryShown);
	const mapFitKey = JSON.stringify(libraryScope);
	// "Show on map": center on this photo instead of fitting all points.
	const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);
	const clearMapFocus = useCallback(() => setMapFocus(null), []);

	// The map shows the library scope, so entering it leaves Find similar,
	// Review, and Duplicates (like choosing a folder does).
	const { setViewMode: setLibraryViewMode } = library;
	const changeViewMode = useCallback(
		(mode: ViewMode) => {
			if (mode === "map") {
				setSimilarSource(null);
				setCatalogView(null);
			}
			setLibraryViewMode(mode);
		},
		[setLibraryViewMode],
	);

	const handleFindSimilar = useCallback(() => {
		const source = library.activePhoto;
		if (!source) return;
		setSearchQuery("");
		setCatalogView(null);
		setSimilarSource(source);
		library.setViewMode("grid");
	}, [library.activePhoto, library.setViewMode]);

	const exitSimilar = useCallback(() => setSimilarSource(null), []);

	const activeLocation = library.activePhoto
		? photoLocation(library.activePhoto)
		: null;
	const activeLocationPhotoId = library.activePhoto?.id;
	const showActiveOnMap = useCallback(() => {
		if (!activeLocation || activeLocationPhotoId === undefined) return;
		setMapFocus({ photoId: activeLocationPhotoId, ...activeLocation });
		changeViewMode("map");
	}, [activeLocation, activeLocationPhotoId, changeViewMode]);

	// Map point: open that photo in the loupe (from the grid list when it is
	// there, so loupe navigation continues from it).
	const utils = trpc.useUtils();
	const { openInLoupe } = library;
	const handleMapPointClick = useCallback(
		async (photoId: number) => {
			const photo =
				photos.find((p) => p.id === photoId) ??
				(await utils.photo.fetch({ id: photoId }));
			openInLoupe(photo);
		},
		[photos, utils, openInLoupe],
	);

	// Review: resolving the active candidate advances to the next one.
	const { resolve: resolveJunk, photos: reviewPhotos } = review;
	const { activePhoto, setActivePhoto } = library;
	const activeReviewPhoto = reviewActive
		? reviewPhotos.find((photo) => photo.id === activePhoto?.id)
		: undefined;
	const resolveActiveReviewPhoto = useCallback(
		(action: JunkAction) => {
			const index = reviewPhotos.findIndex((p) => p.id === activePhoto?.id);
			if (index === -1) return;
			resolveJunk([reviewPhotos[index]], action);
			setActivePhoto(
				reviewPhotos[index + 1] ?? reviewPhotos[index - 1] ?? null,
			);
		},
		[reviewPhotos, activePhoto, resolveJunk, setActivePhoto],
	);
	const resolveShownReviewPhotos = useCallback(
		(action: JunkAction) => {
			resolveJunk(reviewPhotos, action);
			setActivePhoto(null);
		},
		[reviewPhotos, resolveJunk, setActivePhoto],
	);

	// Ratings/flags: optimistic across every cached photo list and the active photo.
	const { setCuration } = usePhotoCuration(library.patchActivePhoto);
	const curateActivePhoto = useCallback(
		(patch: CurationPatch) => {
			if (library.activePhoto) setCuration([library.activePhoto], patch);
		},
		[library.activePhoto, setCuration],
	);

	// `B`: toggle the active photo in the last-used collection.
	const { lastUsedCollectionId, toggleLastUsedCollection } = collectionsApi;
	const activePhotoId = library.activePhoto?.id;
	const toggleActiveInLastUsed = useCallback(() => {
		if (activePhotoId !== undefined) {
			void toggleLastUsedCollection(activePhotoId);
		}
	}, [activePhotoId, toggleLastUsedCollection]);

	// `Shift+D`: download the active photo as JPEG 2048, or a video's original.
	const activePhotoName = library.activePhoto?.name;
	const activeIsVideo = library.activePhoto?.mediaType === "video";
	const downloadActivePhoto = useCallback(() => {
		if (activePhotoId === undefined || activePhotoName === undefined) return;
		const size = activeIsVideo ? "original" : "2048";
		downloadUrl(
			exportPhotoUrl(activePhotoId, size),
			exportFileName(activePhotoName, size),
		);
	}, [activePhotoId, activePhotoName, activeIsVideo]);

	// `Space` in the loupe: play/pause the shown video (set by LoupeView).
	const loupeVideoRef = useRef<HTMLVideoElement | null>(null);
	const toggleVideoPlayback = useCallback(() => {
		const video = loupeVideoRef.current;
		if (!video) return;
		if (video.paused) void video.play().catch(() => {});
		else video.pause();
	}, []);

	// `F` / toolbar: face boxes over a still in the loupe (People view aside).
	const [showFaces, setShowFaces] = useState(false);
	const faceBoxesAvailable =
		library.viewMode === "loupe" &&
		!peopleActive &&
		library.activePhoto !== null &&
		!activeIsVideo;
	const toggleFaceBoxes = useCallback(
		() => setShowFaces((current) => !current),
		[],
	);
	const loupeFacesQuery = trpc.photoFaces.useQuery(
		{ photoId: activePhotoId ?? 0 },
		{ enabled: faceBoxesAvailable && showFaces && activePhotoId !== undefined },
	);
	// A face box focuses its metadata row (opening the panel when hidden).
	const { rightPanelVisible, toggleRightPanel } = panels;
	const focusFaceRow = useCallback(
		(face: PhotoFace) => {
			if (!rightPanelVisible) toggleRightPanel();
			requestAnimationFrame(() => {
				const row = document.getElementById(faceRowId(face.id));
				row?.scrollIntoView({ block: "nearest" });
				row?.focus();
			});
		},
		[rightPanelVisible, toggleRightPanel],
	);

	// Keyboard shortcuts
	useKeyboardShortcuts({
		viewMode: library.viewMode,
		setViewMode: changeViewMode,
		toggleAllPanels: panels.toggleAllPanels,
		toggleFilmstrip: panels.toggleFilmstrip,
		navigatePhoto: library.navigatePhoto,
		hasActivePhoto: library.activePhoto !== null,
		findSimilar: handleFindSimilar,
		exitSimilar: similarSource ? exitSimilar : null,
		curateActivePhoto,
		toggleLastUsedCollection:
			lastUsedCollectionId === null ? null : toggleActiveInLastUsed,
		resolveReviewPhoto: reviewActive ? resolveActiveReviewPhoto : null,
		downloadActivePhoto,
		toggleVideoPlayback:
			library.viewMode === "loupe" && activeIsVideo
				? toggleVideoPlayback
				: null,
		toggleFaceBoxes: faceBoxesAvailable ? toggleFaceBoxes : null,
	});

	const handlePhotoClick = useCallback(
		(photo: PhotoMetadata) => {
			library.setActivePhoto(photo);
		},
		[library.setActivePhoto],
	);

	const handlePhotoDoubleClick = useCallback(
		(photo: PhotoMetadata) => {
			library.openInLoupe(photo);
		},
		[library.openInLoupe],
	);

	const handleFilmstripClick = useCallback(
		(photo: PhotoMetadata) => {
			library.setActivePhoto(photo);
		},
		[library.setActivePhoto],
	);

	// ⌘K focuses the sidebar search (opening the sidebar first); ⌘\ collapses it.
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const { leftPanelVisible, leftPanelCollapsed } = panels;
	const { toggleLeftPanel, toggleLeftPanelCollapsed } = panels;
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey)) return;
			if (e.key.toLowerCase() === "k") {
				e.preventDefault();
				if (!leftPanelVisible) toggleLeftPanel();
				if (leftPanelCollapsed) toggleLeftPanelCollapsed();
				requestAnimationFrame(() => {
					requestAnimationFrame(() => searchInputRef.current?.focus());
				});
			} else if (e.key === "\\") {
				e.preventDefault();
				toggleLeftPanelCollapsed();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [
		leftPanelVisible,
		leftPanelCollapsed,
		toggleLeftPanel,
		toggleLeftPanelCollapsed,
	]);

	const handleSearchChange = useCallback((query: string) => {
		setSearchQuery(query);
		if (query) {
			setSimilarSource(null);
			setCatalogView(null);
		}
	}, []);

	const handleScan = useCallback(
		(force = false) => {
			if (scanDisabled) return;
			setSearchQuery("");
			setSimilarSource(null);
			setSelectedFolder(null);
			setSelectedCollectionId(null);
			scanMutation.mutate(force ? { force: true } : undefined);
		},
		[scanMutation, scanDisabled],
	);

	const handleFolderSelect = useCallback((folder: string | null) => {
		// Folder selection scopes an active search rather than clearing it.
		setSelectedFolder(folder);
		setSelectedCollectionId(null);
		setSimilarSource(null);
		setCatalogView(null);
	}, []);

	const handleCollectionSelect = useCallback((id: number | null) => {
		// Like folders, a collection scopes an active search; the two are exclusive.
		setSelectedCollectionId(id);
		setSelectedFolder(null);
		setSimilarSource(null);
		setCatalogView(null);
	}, []);

	const handleReviewSelect = useCallback(() => {
		setCatalogView("review");
		setSimilarSource(null);
		setActivePhoto(null);
		// Review, Duplicates, and People replace the library, which the map shows.
		if (mapActive) setLibraryViewMode("grid");
	}, [setActivePhoto, mapActive, setLibraryViewMode]);

	const handleDuplicatesSelect = useCallback(() => {
		setCatalogView("duplicates");
		setSimilarSource(null);
		setActivePhoto(null);
		if (mapActive) setLibraryViewMode("grid");
	}, [setActivePhoto, mapActive, setLibraryViewMode]);

	const handlePeopleSelect = useCallback(() => {
		setCatalogView("people");
		setSimilarSource(null);
		setActivePhoto(null);
		// People has no photos to show in the loupe or on the map.
		if (library.viewMode !== "grid") setLibraryViewMode("grid");
	}, [setActivePhoto, library.viewMode, setLibraryViewMode]);

	// A person card scopes the library (and an active search) to that person.
	const handlePersonSelect = useCallback(
		(personId: number) => {
			setFilters((current) => ({ ...current, personId }));
			setCatalogView(null);
			setActivePhoto(null);
		},
		[setActivePhoto],
	);

	const exitCatalogView = useCallback(() => {
		setCatalogView(null);
		setActivePhoto(null);
	}, [setActivePhoto]);

	// "Show N photos in this area": the viewport becomes the "Map area" filter.
	const handleShowMapArea = useCallback(
		(bounds: PhotoBounds) => {
			setFilters((current) => ({ ...current, bounds }));
			setLibraryViewMode("grid");
		},
		[setLibraryViewMode],
	);

	const { deleteCollection } = collectionsApi;
	const handleDeleteCollection = useCallback(
		async (id: number) => {
			await deleteCollection(id);
			// Deleting the viewed collection returns to All Photos.
			setSelectedCollectionId((current) => (current === id ? null : current));
		},
		[deleteCollection],
	);

	const { setViewMode } = library;

	// Applying a smart album replaces the folder, filters, and search with its
	// saved ones and leaves collection, Find similar, and Review modes.
	const handleSmartAlbumSelect = useCallback(
		(album: SmartAlbum) => {
			setAppliedSmartAlbumId(album.id);
			setFilters(fromSmartAlbumFilters(album.filters));
			setSelectedFolder(album.filters.folder ?? null);
			setSearchQuery(album.query ?? "");
			setSelectedCollectionId(null);
			setSimilarSource(null);
			setCatalogView(null);
			setViewMode("grid");
		},
		[setViewMode],
	);

	const { createSmartAlbum } = smartAlbumsApi;
	const saveSmartAlbum = useCallback(
		async (name: string) => {
			const album = await createSmartAlbum(
				name,
				currentSmartAlbumFilters,
				currentSmartAlbumQuery,
			);
			// The saved album now describes exactly what is shown.
			setAppliedSmartAlbumId(album.id);
		},
		[createSmartAlbum, currentSmartAlbumFilters, currentSmartAlbumQuery],
	);

	// The header ✕ leaves the album for the unfiltered library.
	const closeSmartAlbum = useCallback(() => {
		setAppliedSmartAlbumId(null);
		setFilters(EMPTY_LIBRARY_FILTERS);
		setSelectedFolder(null);
		setSearchQuery("");
	}, []);

	// Metadata tag chip: filter the library (or the active search) by that tag.
	const handleTagSelect = useCallback(
		(tag: string) => {
			setFilters((current) => ({ ...current, tag }));
			setSimilarSource(null);
			setCatalogView(null);
			setViewMode("grid");
		},
		[setViewMode],
	);

	// Metadata Place row: filter the library (or the active search) by that city.
	const handlePlaceSelect = useCallback(
		(place: PhotoPlace) => {
			setFilters((current) => ({
				...current,
				country: place.countryCode,
				place: place.id,
			}));
			setSimilarSource(null);
			setCatalogView(null);
			setViewMode("grid");
		},
		[setViewMode],
	);

	// "On this day" card: filter the library to that capture date.
	const handleCapturedDateSelect = useCallback(
		(capturedDate: string) => {
			setFilters((current) => ({ ...current, capturedDate }));
			setActivePhoto(null);
		},
		[setActivePhoto],
	);

	// Library panel event: filter to its photos (null clears). Like choosing a
	// folder, it leaves Find similar, Review, and Duplicates.
	const handleEventSelect = useCallback(
		(event: EventSummary | null) => {
			setFilters((current) => ({ ...current, event }));
			setSimilarSource(null);
			setCatalogView(null);
			setActivePhoto(null);
			if (library.viewMode === "loupe") setViewMode("grid");
		},
		[setActivePhoto, library.viewMode, setViewMode],
	);

	// Gear stats camera/lens row: apply that filter and return to the grid.
	const handleGearCameraSelect = useCallback((camera: string) => {
		setFilters((current) => ({ ...current, camera }));
		setGearActive(false);
	}, []);
	const handleGearLensSelect = useCallback((lens: string) => {
		setFilters((current) => ({ ...current, lens }));
		setGearActive(false);
	}, []);

	// Navigation helpers for loupe - memoized to avoid recalculation on every render
	const { hasPrev, hasNext } = useMemo(() => {
		const currentIndex = library.activePhoto
			? photos.findIndex((p) => p.id === library.activePhoto?.id)
			: -1;
		return {
			hasPrev: currentIndex > 0,
			hasNext: currentIndex < photos.length - 1,
		};
	}, [library.activePhoto, photos]);

	// Render content based on view mode
	const renderContent = () => {
		// The map has its own query and scope, independent of the photo list.
		if (mapActive) {
			return (
				<Suspense
					fallback={
						<Spinner />
					}
				>
					<MapView
						points={photoLocationsQuery.data?.points}
						error={photoLocationsQuery.error}
						fitKey={mapFitKey}
						focus={mapFocus}
						onFocusApplied={clearMapFocus}
						onPointClick={(photoId) => void handleMapPointClick(photoId)}
						onShowArea={handleShowMapArea}
					/>
				</Suspense>
			);
		}

		// People replaces the library in every non-map view mode.
		if (peopleActive) {
			return (
				<PeopleView
					people={peopleApi.people}
					loading={peopleApi.listQuery.isLoading}
					loadError={peopleApi.listQuery.error?.message ?? null}
					showHidden={showHiddenPeople}
					onShowHiddenChange={setShowHiddenPeople}
					onSelect={(person) => handlePersonSelect(person.id)}
					onRename={(person, name) => void peopleApi.rename(person, name)}
					onSetHidden={(person, hidden) =>
						void peopleApi.setHidden(person, hidden)
					}
					onMerge={(target, sources) => void peopleApi.merge(target, sources)}
					error={peopleApi.error}
					onDismissError={peopleApi.clearError}
					onExit={exitCatalogView}
				/>
			);
		}

		if (gearShown) {
			return (
				<GearStatsView
					stats={gearStatsQuery.data}
					error={gearStatsQuery.error}
					onCameraSelect={handleGearCameraSelect}
					onLensSelect={handleGearLensSelect}
				/>
			);
		}

		if (loading) {
			return (
				<Spinner label="Loading photos..." />
			);
		}

		if (error) {
			return (
				<div className="flex h-full flex-col items-center justify-center">
					<div className="rounded-lg border border-destructive/20 bg-destructive/10 px-6 py-4 text-destructive">
						<p className="font-medium">Error loading photos</p>
						<p className="text-sm">{error.message}</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => handleScan()}
							disabled={scanDisabled}
							className="mt-4"
						>
							Try again
						</Button>
					</div>
				</div>
			);
		}

		if (library.viewMode === "loupe") {
			return (
				<LoupeView
					photo={library.activePhoto}
					onNavigate={library.navigatePhoto}
					hasPrev={hasPrev}
					hasNext={hasNext}
					videoRef={loupeVideoRef}
					showFaces={showFaces && faceBoxesAvailable}
					faces={loupeFacesQuery.data?.faces}
					onFaceClick={focusFaceRow}
				/>
			);
		}
		if (similarNotIndexed) {
			return (
				<EmptyState title="This photo hasn't been indexed yet. Run a scan to enable similar-photo search." />
			);
		}

		if (duplicatesActive) {
			if (duplicates.groups.length === 0) {
				return (
					<EmptyState
						data-testid="duplicates-empty"
						icon={<Copy />}
						title="No duplicates or bursts"
					/>
				);
			}
			return (
				<DuplicateGroupList
					groups={duplicates.groups}
					activePhotoId={library.activePhoto?.id}
					onPhotoActivate={handlePhotoClick}
					onPhotoOpen={handlePhotoDoubleClick}
					onKeep={duplicates.resolve}
					onDismiss={(group) => duplicates.resolve(group, null)}
					hasMore={duplicates.listQuery.hasNextPage}
					loadingMore={duplicates.listQuery.isFetchingNextPage}
					onLoadMore={() => void duplicates.listQuery.fetchNextPage()}
				/>
			);
		}

		if (reviewActive) {
			if (reviewPhotos.length === 0) {
				return (
					<EmptyState
						data-testid="review-empty"
						icon={<ScanEye />}
						title="Nothing to review"
					/>
				);
			}
			return (
				<PhotoGrid
					photos={reviewPhotos}
					activePhotoId={library.activePhoto?.id}
					thumbnailSize={library.thumbnailSize}
					onPhotoClick={handlePhotoClick}
					onPhotoDoubleClick={handlePhotoDoubleClick}
					badgeLabel={(photo) =>
						photo.junkReasons[0] && JUNK_REASON_LABELS[photo.junkReasons[0]]
					}
				/>
			);
		}

		const grid = (
			<PhotoGrid
				photos={photos}
				sections={timeline.sections}
				activePhotoId={library.activePhoto?.id}
				thumbnailSize={library.thumbnailSize}
				onPhotoClick={handlePhotoClick}
				onPhotoDoubleClick={handlePhotoDoubleClick}
			/>
		);
		if (onThisDay.years.length === 0) return grid;
		return (
			<div className="flex h-full flex-col">
				<OnThisDayStrip
					years={onThisDay.years}
					onSelect={handleCapturedDateSelect}
				/>
				<div className="min-h-0 flex-1">{grid}</div>
			</div>
		);
	};

	const similarChip = similarSource && (
		<div
			data-testid="similar-chip"
			className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-sm"
		>
			<RemovableChip
				icon={<Sparkles className="h-3.5 w-3.5 shrink-0" />}
				clearLabel="Exit similar photos"
				onClear={exitSimilar}
				className="min-w-0 pl-2.5 text-sm"
			>
				<span className="truncate">Similar to {similarSource.name}</span>
			</RemovableChip>
		</div>
	);

	const searchScope = [
		filters.filterRaw === "raw"
			? "RAW only"
			: filters.filterRaw === "standard"
				? "Standard only"
				: filters.filterRaw === "video"
					? "Videos only"
					: null,
		filters.camera,
		filters.lens,
		filters.iso !== null ? `ISO ${filters.iso}` : null,
		filters.dateMonth !== null ? formatMonthLabel(filters.dateMonth) : null,
		filters.minRating !== null ? minRatingLabel(filters.minRating) : null,
		filters.flag !== null ? FLAG_FILTER_LABELS[filters.flag] : null,
		filters.tag !== null ? `#${filters.tag}` : null,
		// The city alone names the place filter; otherwise the country.
		filters.place !== null
			? (filterOptionsQuery.data?.places.find((p) => p.id === filters.place)
					?.name ?? null)
			: filters.country !== null
				? (filterOptionsQuery.data?.countries.find(
						(c) => c.code === filters.country,
					)?.name ?? filters.country)
				: null,
		personScopeLabel,
	].filter((part): part is string => part !== null);
	// What "Save as Smart Album" stores (collection scope, map area, and
	// capture date are never saved).
	const smartAlbumSummary = [
		currentSmartAlbumQuery !== null ? `“${currentSmartAlbumQuery}”` : null,
		selectedFolder,
		...searchScope,
	]
		.filter((part): part is string => part !== null)
		.join(" · ");
	const searchResultCount = searchPhotosQuery.data?.photos.length;
	const searchHeader = searchQuery && (
		<ViewHeader
			data-testid="search-header"
			icon={<Search />}
			titleAs="span"
			exitLabel="Clear search"
			onExit={() => setSearchQuery("")}
			title={
				<>
				{searchResultCount === undefined
					? "Searching"
					: `${searchResultCount} ${searchResultCount === 1 ? "result" : "results"}`}{" "}
				for “{searchQuery}”{selectedFolder ? ` in ${selectedFolder}` : ""}
				{selectedCollection ? ` in ${selectedCollection.name}` : ""}
				{searchScope.length > 0 ? ` · ${searchScope.join(" · ")}` : ""}
				{filters.capturedDate
					? ` · ${formatCapturedDate(filters.capturedDate)}`
					: ""}
				{filters.event ? ` · ${eventTitle(filters.event)}` : ""}
				{filters.bounds ? " · Map area" : ""}
				</>
			}
		/>
	);
	const collectionHeader = selectedCollection && (
		<ViewHeader
			data-testid="collection-header"
			icon={<Layers />}
			title={selectedCollection.name}
			meta={`${selectedCollection.photoCount} ${selectedCollection.photoCount === 1 ? "photo" : "photos"}`}
			exitLabel="Show all photos"
			onExit={() => handleCollectionSelect(null)}
		/>
	);
	const personHeader = personScopeLabel !== null && (
		<ViewHeader
			data-testid="person-header"
			icon={<UserRound />}
			title={personScopeLabel}
			exitLabel="Leave person"
			onExit={() => setFilters((current) => ({ ...current, personId: null }))}
		/>
	);
	const scopeHeaders =
		collectionHeader || personHeader ? (
			<>
				{collectionHeader}
				{personHeader}
			</>
		) : null;
	const reviewHeader = reviewActive && (
		<ReviewHeader
			reason={reviewReason}
			onReasonChange={(reason) => {
				setReviewReason(reason);
				setActivePhoto(null);
			}}
			counts={review.counts}
			shownCount={reviewPhotos.length}
			onRejectAll={() => resolveShownReviewPhotos("reject")}
			onKeepAll={() => resolveShownReviewPhotos("keep")}
			error={review.error}
			onDismissError={review.clearError}
			onExit={exitCatalogView}
		/>
	);
	const duplicatesHeader = duplicatesActive && (
		<DuplicatesHeader
			kind={duplicateKind}
			onKindChange={(kind) => {
				setDuplicateKind(kind);
				setActivePhoto(null);
			}}
			counts={duplicates.counts}
			error={duplicates.error}
			onDismissError={duplicates.clearError}
			onExit={exitCatalogView}
		/>
	);
	const smartAlbumHeader = selectedSmartAlbum && (
		<ViewHeader
			data-testid="smart-album-header"
			icon={<ListFilter />}
			title={selectedSmartAlbum.name}
			meta={
				selectedSmartAlbum.photoCount === null
					? "Smart album"
					: `${selectedSmartAlbum.photoCount} ${selectedSmartAlbum.photoCount === 1 ? "photo" : "photos"}`
			}
			exitLabel="Close smart album"
			onExit={closeSmartAlbum}
		/>
	);
	// A query album names itself above the search results header.
	const banner = mapActive
		? // The map shows the library scope: search and Find similar do not apply.
			scopeHeaders
		: peopleActive
			? null
			: reviewHeader ||
				duplicatesHeader ||
				similarChip ||
				(smartAlbumHeader || searchHeader ? (
					<>
						{smartAlbumHeader}
						{searchHeader}
					</>
				) : null) ||
				scopeHeaders;

	// Breadcrumbs name the scope as a path; the title and count follow it.
	const goLibrary = () => {
		setSearchQuery("");
		setSimilarSource(null);
		setSelectedFolder(null);
		setSelectedCollectionId(null);
		setCatalogView(null);
		setAppliedSmartAlbumId(null);
	};
	const crumbs: Crumb[] = [{ label: "Library", onSelect: goLibrary }];
	let title = "Photos";
	if (reviewActive) {
		title = "Review";
		crumbs.push({ label: "Clean up" }, { label: "Review" });
	} else if (duplicatesActive) {
		title = "Duplicates";
		crumbs.push({ label: "Clean up" }, { label: "Duplicates" });
	} else if (peopleActive) {
		title = "People";
		crumbs.push({ label: "People" });
	} else if (similarSource) {
		title = "Similar photos";
		crumbs.push({ label: `Similar to ${similarSource.name}` });
	} else if (searchQuery) {
		title = "Search";
		crumbs.push({ label: "Search" }, { label: `“${searchQuery}”` });
	} else if (selectedSmartAlbum) {
		title = selectedSmartAlbum.name;
		crumbs.push({ label: "Smart albums" }, { label: selectedSmartAlbum.name });
	} else if (selectedCollection) {
		title = selectedCollection.name;
		crumbs.push({ label: "Collections" }, { label: selectedCollection.name });
	} else if (selectedFolder) {
		const parts = selectedFolder.split("/").filter(Boolean);
		title = parts[parts.length - 1] ?? selectedFolder;
		parts.forEach((part, index) => {
			const path = parts.slice(0, index + 1).join("/");
			crumbs.push(
				index === parts.length - 1
					? { label: part }
					: { label: part, onSelect: () => handleFolderSelect(path) },
			);
		});
	}
	const statusMode: StatusMode = reviewActive
		? "review"
		: duplicatesActive
			? "duplicates"
			: peopleActive
				? "people"
				: library.viewMode === "loupe"
					? "loupe"
					: "library";
	const activeIndex = library.activePhoto
		? photos.findIndex((p) => p.id === library.activePhoto?.id)
		: -1;

	return (
		<PanelLayout
			header={
				<AppHeader
					crumbs={crumbs}
					title={title}
					meta={`${photos.length} photos`}
					onSaveSmartAlbum={
						canSaveSmartAlbum && !catalogView
							? () => setSavingSmartAlbum(true)
							: undefined
					}
					viewMode={library.viewMode}
					onViewModeChange={changeViewMode}
					thumbnailSize={library.thumbnailSize}
					onThumbnailSizeChange={library.setThumbnailSize}
					timeline={
						libraryGrid && !gearShown
							? {
									grouping: timelineSettings.grouping,
									onGroupingChange: timelineSettings.setGrouping,
									sort: timelineSettings.sort,
									onSortChange: timelineSettings.setSort,
									calendarCounts,
									capturedDate: filters.capturedDate,
									onCapturedDateSelect: handleCapturedDateSelect,
								}
							: null
					}
					gearStats={
						libraryGrid
							? {
									active: gearShown,
									onToggle: () => setGearActive((current) => !current),
								}
							: null
					}
					faces={
						faceBoxesAvailable
							? { shown: showFaces, onToggle: toggleFaceBoxes }
							: null
					}
					filtersAvailable={catalogView === null}
					filterOptions={filterOptionsQuery.data}
					filters={filters}
					onFiltersChange={setFilters}
					onEventClear={() => handleEventSelect(null)}
					personLabel={personScopeLabel}
					leftPanelVisible={panels.leftPanelVisible}
					rightPanelVisible={panels.rightPanelVisible}
					onToggleLeftPanel={panels.toggleLeftPanel}
					onToggleRightPanel={panels.toggleRightPanel}
					onRefresh={() => handleScan()}
					onReprocess={() => handleScan(true)}
					isRefreshing={scanMutation.isPending}
					uploads={uploads}
					hasActiveJobs={jobProgress.isActive}
				/>
			}
			footer={
				<StatusBar
					mode={statusMode}
					shown={photos.length}
					total={foldersQuery.data?.totalPhotos}
					hasActivePhoto={library.activePhoto !== null}
					loupeLabel={
						library.activePhoto
							? `${activeIndex + 1} of ${photos.length} · ${library.activePhoto.name}`
							: undefined
					}
					queueLabel={
						reviewActive
							? `${review.counts?.all ?? reviewPhotos.length} candidates`
							: `${duplicates.groups.length} groups shown`
					}
					progress={{
						active: jobProgress.isActive,
						label: "Indexing",
						percentage: jobProgress.progress.percentage,
					}}
				/>
			}
			leftPanel={
				<AppSidebar
					ref={searchInputRef}
					photoCount={foldersQuery.data?.totalPhotos ?? photos.length}
					folders={foldersQuery.data?.folders}
					selectedFolder={selectedFolder}
					onFolderSelect={handleFolderSelect}
					collections={collectionsApi.collections}
					selectedCollectionId={selectedCollectionId}
					onCollectionSelect={handleCollectionSelect}
					onCreateCollection={collectionsApi.createCollection}
					onRenameCollection={collectionsApi.renameCollection}
					onDeleteCollection={handleDeleteCollection}
					smartAlbums={smartAlbumsApi.albums}
					selectedSmartAlbumId={selectedSmartAlbum?.id ?? null}
					onSmartAlbumSelect={handleSmartAlbumSelect}
					onRenameSmartAlbum={smartAlbumsApi.renameSmartAlbum}
					onDeleteSmartAlbum={smartAlbumsApi.deleteSmartAlbum}
					events={eventsQuery.data?.events}
					selectedEvent={filters.event}
					onEventSelect={handleEventSelect}
					reviewCount={review.counts?.all}
					reviewActive={reviewActive}
					onReviewSelect={handleReviewSelect}
					duplicateCount={
						duplicates.counts &&
						duplicates.counts.duplicate + duplicates.counts.burst
					}
					duplicatesActive={duplicatesActive}
					onDuplicatesSelect={handleDuplicatesSelect}
					peopleCount={peopleApi.count}
					peopleActive={peopleActive}
					onPeopleSelect={peopleActive ? exitCatalogView : handlePeopleSelect}
					searchQuery={searchQuery}
					onSearchChange={handleSearchChange}
					collapsed={panels.leftPanelCollapsed}
					onToggleCollapsed={panels.toggleLeftPanelCollapsed}
					activity={
						<ActivityPanel
							progress={jobProgress.progress}
							isActive={jobProgress.isActive}
							isCompleted={jobProgress.isCompleted}
						/>
					}
				/>
			}
			rightPanel={
				<MetadataPanel
					photo={library.activePhoto}
					onFindSimilar={handleFindSimilar}
					onCurate={curateActivePhoto}
					onTagSelect={handleTagSelect}
					onPlaceSelect={handlePlaceSelect}
					onShowOnMap={activeLocation ? showActiveOnMap : undefined}
					collections={{
						collections: collectionsApi.collections,
						onSetMembership: collectionsApi.setMembership,
						onCreate: collectionsApi.createCollection,
						error: collectionsApi.membershipError,
					}}
					review={
						activeReviewPhoto && {
							reasons: activeReviewPhoto.junkReasons,
							onResolve: resolveActiveReviewPhoto,
						}
					}
				/>
			}
			filmstrip={
				<Filmstrip
					photos={photos}
					activePhotoId={library.activePhoto?.id}
					onPhotoClick={handleFilmstripClick}
				/>
			}
			leftPanelVisible={panels.leftPanelVisible}
			leftPanelCollapsed={panels.leftPanelCollapsed}
			rightPanelVisible={panels.rightPanelVisible}
			filmstripVisible={panels.filmstripVisible && library.viewMode === "loupe"}
		>
			<UploadDropZone enabled={uploads.enabled} onFiles={uploads.addFiles}>
				{banner ? (
					<div className="flex h-full flex-col">
						{banner}
						<div className="min-h-0 flex-1">{renderContent()}</div>
					</div>
				) : (
					renderContent()
				)}
			</UploadDropZone>
			<SaveSmartAlbumSheet
				open={savingSmartAlbum}
				onOpenChange={setSavingSmartAlbum}
				summary={smartAlbumSummary}
				onSave={saveSmartAlbum}
			/>
		</PanelLayout>
	);
}
