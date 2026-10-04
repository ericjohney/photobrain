import {
	Copy,
	Layers,
	ListFilter,
	Loader2,
	ScanEye,
	Search,
	Sparkles,
	X,
} from "lucide-react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { DuplicateGroupList } from "@/components/DuplicateGroupList";
import { DuplicatesHeader } from "@/components/DuplicatesHeader";
import { Filmstrip } from "@/components/Filmstrip";
import { LoupeView } from "@/components/LoupeView";
import type { MapFocus } from "@/components/MapView";
import { PhotoGrid } from "@/components/PhotoGrid";
import { ActivityPanel } from "@/components/panels/ActivityPanel";
import {
	EMPTY_LIBRARY_FILTERS,
	FLAG_FILTER_LABELS,
	type LibraryFilters,
	LibraryPanel,
	minRatingLabel,
} from "@/components/panels/LibraryPanel";
import { MetadataPanel } from "@/components/panels/MetadataPanel";
import { PanelLayout } from "@/components/panels/PanelLayout";
import { ReviewHeader } from "@/components/ReviewHeader";
import { SaveSmartAlbumSheet } from "@/components/SaveSmartAlbumSheet";
import { Toolbar } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import { useCollections } from "@/hooks/use-collections";
import { useDuplicateGroups } from "@/hooks/use-duplicate-groups";
import { useJobProgress } from "@/hooks/use-job-progress";
import { useJunkReview } from "@/hooks/use-junk-review";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useLibraryState, type ViewMode } from "@/hooks/use-library-state";
import { usePanelState } from "@/hooks/use-panel-state";
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
import { JUNK_REASON_LABELS } from "@/lib/junk-review";
import { photoLocation } from "@/lib/map";
import { trpc } from "@/lib/trpc";
import type {
	DuplicateKind,
	JunkAction,
	JunkReason,
	PhotoBounds,
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
	// Review and Duplicates replace the library view; folder, collection, and
	// filters are kept (but ignored) so leaving them restores the library.
	const [catalogView, setCatalogView] = useState<
		"review" | "duplicates" | null
	>(null);
	const reviewActive = catalogView === "review";
	const duplicatesActive = catalogView === "duplicates";
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
		// A map area narrows the album, so it no longer shows exactly the album.
		filters.bounds === null &&
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
	// Collection scope and map area are never saved, so either alone (or
	// together) is not savable; with other filters they are left out.
	const canSaveSmartAlbum =
		Object.keys(currentSmartAlbumFilters).length > 0 ||
		currentSmartAlbumQuery !== null;

	// tRPC queries
	const foldersQuery = trpc.folders.useQuery();

	const filterOptionsQuery = trpc.filterOptions.useQuery({
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
	};
	const bounds = filters.bounds ?? undefined;

	const photosQuery = trpc.photos.useQuery(
		{ ...libraryScope, bounds },
		{
			enabled: !searchQuery && catalogView === null,
		},
	);

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
		{ photoId: similarSource?.id ?? 0, limit: 60 },
		{ enabled: similarSource !== null },
	);

	const review = useJunkReview({ active: reviewActive, reason: reviewReason });
	const duplicates = useDuplicateGroups({
		active: duplicatesActive,
		kind: duplicateKind,
	});
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

	// Determine which data to use
	const activeQuery = reviewActive
		? review.listQuery
		: similarSource
			? similarPhotosQuery
			: searchQuery
				? searchPhotosQuery
				: photosQuery;
	const photos: PhotoMetadata[] = duplicatesActive
		? duplicatePhotos
		: (activeQuery.data?.photos ?? []);
	const loading = duplicatesActive
		? duplicates.listQuery.isLoading
		: activeQuery.isLoading;
	const error = duplicatesActive
		? duplicates.listQuery.error
		: activeQuery.error;
	const similarNotIndexed =
		similarSource !== null && similarPhotosQuery.data?.indexed === false;

	// State management hooks
	const library = useLibraryState(photos);
	const panels = usePanelState();
	const mapActive = library.viewMode === "map";

	// Map: every geotagged photo in the library scope (folder/collection and
	// filters, not the search query or the current map area).
	const photoLocationsQuery = trpc.photoLocations.useQuery(libraryScope, {
		enabled: mapActive,
	});
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

	const handleSearch = useCallback(() => {
		// Query is reactive, nothing needed here
	}, []);

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
		// Review and Duplicates replace the library, which the map shows.
		if (mapActive) setLibraryViewMode("grid");
	}, [setActivePhoto, mapActive, setLibraryViewMode]);

	const handleDuplicatesSelect = useCallback(() => {
		setCatalogView("duplicates");
		setSimilarSource(null);
		setActivePhoto(null);
		if (mapActive) setLibraryViewMode("grid");
	}, [setActivePhoto, mapActive, setLibraryViewMode]);

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
						<div className="flex h-full items-center justify-center">
							<Loader2 className="h-10 w-10 animate-spin text-primary" />
						</div>
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

		if (loading) {
			return (
				<div className="flex h-full flex-col items-center justify-center">
					<Loader2 className="h-10 w-10 animate-spin text-primary mb-3" />
					<p className="text-sm text-muted-foreground">Loading photos...</p>
				</div>
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
				/>
			);
		}
		if (similarNotIndexed) {
			return (
				<div className="flex h-full items-center justify-center px-6">
					<p className="text-sm text-muted-foreground">
						This photo hasn't been indexed yet. Run a scan to enable
						similar-photo search.
					</p>
				</div>
			);
		}

		if (duplicatesActive) {
			if (duplicates.groups.length === 0) {
				return (
					<div
						data-testid="duplicates-empty"
						className="flex h-full flex-col items-center justify-center text-muted-foreground"
					>
						<Copy className="mb-4 h-16 w-16 opacity-20" />
						<p className="text-sm font-medium">No duplicates or bursts</p>
					</div>
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
					<div
						data-testid="review-empty"
						className="flex h-full flex-col items-center justify-center text-muted-foreground"
					>
						<ScanEye className="mb-4 h-16 w-16 opacity-20" />
						<p className="text-sm font-medium">Nothing to review</p>
					</div>
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

		return (
			<PhotoGrid
				photos={photos}
				activePhotoId={library.activePhoto?.id}
				thumbnailSize={library.thumbnailSize}
				onPhotoClick={handlePhotoClick}
				onPhotoDoubleClick={handlePhotoDoubleClick}
			/>
		);
	};

	const similarChip = similarSource && (
		<div
			data-testid="similar-chip"
			className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-sm"
		>
			<span className="flex min-w-0 items-center gap-1.5 rounded-full bg-primary/15 py-0.5 pl-2.5 pr-1 text-primary">
				<Sparkles className="h-3.5 w-3.5 shrink-0" />
				<span className="truncate">Similar to {similarSource.name}</span>
				<button
					type="button"
					aria-label="Exit similar photos"
					onClick={exitSimilar}
					className="rounded-full p-0.5 hover:bg-primary/20"
				>
					<X className="h-3.5 w-3.5" />
				</button>
			</span>
		</div>
	);

	const searchScope = [
		filters.filterRaw === "raw"
			? "RAW only"
			: filters.filterRaw === "standard"
				? "Standard only"
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
	].filter((part): part is string => part !== null);
	// What "Save as Smart Album" stores (collection scope and map area are
	// never saved).
	const smartAlbumSummary = [
		currentSmartAlbumQuery !== null ? `“${currentSmartAlbumQuery}”` : null,
		selectedFolder,
		...searchScope,
	]
		.filter((part): part is string => part !== null)
		.join(" · ");
	const searchResultCount = searchPhotosQuery.data?.photos.length;
	const searchHeader = searchQuery && (
		<div
			data-testid="search-header"
			className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-sm"
		>
			<Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			<span className="min-w-0 flex-1 truncate">
				{searchResultCount === undefined
					? "Searching"
					: `${searchResultCount} ${searchResultCount === 1 ? "result" : "results"}`}{" "}
				for “{searchQuery}”{selectedFolder ? ` in ${selectedFolder}` : ""}
				{selectedCollection ? ` in ${selectedCollection.name}` : ""}
				{searchScope.length > 0 ? ` · ${searchScope.join(" · ")}` : ""}
				{filters.bounds ? " · Map area" : ""}
			</span>
			<button
				type="button"
				aria-label="Clear search"
				onClick={() => setSearchQuery("")}
				className="rounded-full p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
			>
				<X className="h-3.5 w-3.5" />
			</button>
		</div>
	);
	const collectionHeader = selectedCollection && (
		<div
			data-testid="collection-header"
			className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-sm"
		>
			<Layers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			<h2 className="min-w-0 truncate font-medium">
				{selectedCollection.name}
			</h2>
			<span className="flex-1 text-xs text-muted-foreground">
				{selectedCollection.photoCount}{" "}
				{selectedCollection.photoCount === 1 ? "photo" : "photos"}
			</span>
			<button
				type="button"
				aria-label="Show all photos"
				onClick={() => handleCollectionSelect(null)}
				className="rounded-full p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
			>
				<X className="h-3.5 w-3.5" />
			</button>
		</div>
	);
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
		<div
			data-testid="smart-album-header"
			className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-sm"
		>
			<ListFilter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			<h2 className="min-w-0 truncate font-medium">
				{selectedSmartAlbum.name}
			</h2>
			<span className="flex-1 text-xs text-muted-foreground">
				{selectedSmartAlbum.photoCount === null
					? "Smart album"
					: `${selectedSmartAlbum.photoCount} ${selectedSmartAlbum.photoCount === 1 ? "photo" : "photos"}`}
			</span>
			<button
				type="button"
				aria-label="Close smart album"
				onClick={closeSmartAlbum}
				className="rounded-full p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
			>
				<X className="h-3.5 w-3.5" />
			</button>
		</div>
	);
	// A query album names itself above the search results header.
	const banner = mapActive
		? // The map shows the library scope: search and Find similar do not apply.
			collectionHeader
		: reviewHeader ||
			duplicatesHeader ||
			similarChip ||
			(smartAlbumHeader || searchHeader ? (
				<>
					{smartAlbumHeader}
					{searchHeader}
				</>
			) : null) ||
			collectionHeader;

	return (
		<PanelLayout
			toolbar={
				<Toolbar
					viewMode={library.viewMode}
					onViewModeChange={changeViewMode}
					thumbnailSize={library.thumbnailSize}
					onThumbnailSizeChange={library.setThumbnailSize}
					leftPanelVisible={panels.leftPanelVisible}
					rightPanelVisible={panels.rightPanelVisible}
					onToggleLeftPanel={panels.toggleLeftPanel}
					onToggleRightPanel={panels.toggleRightPanel}
					searchQuery={searchQuery}
					onSearchChange={handleSearchChange}
					onSearch={handleSearch}
					onRefresh={() => handleScan()}
					onReprocess={() => handleScan(true)}
					isRefreshing={scanMutation.isPending}
					hasActiveJobs={jobProgress.isActive}
					processingProgress={{
						current: jobProgress.progress.current,
						total: jobProgress.progress.total,
					}}
					photoCount={photos.length}
				/>
			}
			leftPanel={
				<div className="flex flex-col h-full">
					<div className="flex-1 overflow-auto">
						<LibraryPanel
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
							onSaveSmartAlbum={
								canSaveSmartAlbum ? () => setSavingSmartAlbum(true) : undefined
							}
							filterOptions={filterOptionsQuery.data}
							activeFilters={filters}
							onFilterChange={setFilters}
							reviewCount={review.counts?.all}
							reviewActive={reviewActive}
							onReviewSelect={handleReviewSelect}
							duplicateCount={
								duplicates.counts &&
								duplicates.counts.duplicate + duplicates.counts.burst
							}
							duplicatesActive={duplicatesActive}
							onDuplicatesSelect={handleDuplicatesSelect}
						/>
					</div>
					<ActivityPanel
						progress={jobProgress.progress}
						isActive={jobProgress.isActive}
						isCompleted={jobProgress.isCompleted}
					/>
				</div>
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
			rightPanelVisible={panels.rightPanelVisible}
			filmstripVisible={panels.filmstripVisible && library.viewMode === "loupe"}
		>
			{banner ? (
				<div className="flex h-full flex-col">
					{banner}
					<div className="min-h-0 flex-1">{renderContent()}</div>
				</div>
			) : (
				renderContent()
			)}
			<SaveSmartAlbumSheet
				open={savingSmartAlbum}
				onOpenChange={setSavingSmartAlbum}
				summary={smartAlbumSummary}
				onSave={saveSmartAlbum}
			/>
		</PanelLayout>
	);
}
