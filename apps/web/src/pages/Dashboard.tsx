import { Layers, Loader2, Search, Sparkles, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Filmstrip } from "@/components/Filmstrip";
import { LoupeView } from "@/components/LoupeView";
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
import { Toolbar } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import { useCollections } from "@/hooks/use-collections";
import { useJobProgress } from "@/hooks/use-job-progress";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useLibraryState } from "@/hooks/use-library-state";
import { usePanelState } from "@/hooks/use-panel-state";
import {
	type CurationPatch,
	usePhotoCuration,
} from "@/hooks/use-photo-curation";
import { trpc } from "@/lib/trpc";
import type { PhotoMetadata } from "@/lib/types";
import { formatMonthLabel } from "@/lib/utils";

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
	const [filters, setFilters] = useState<LibraryFilters>(EMPTY_LIBRARY_FILTERS);
	// The API defaults filterRaw to "all"; omit it from requests in that case.
	const filterRaw = filters.filterRaw === "all" ? undefined : filters.filterRaw;
	const collectionId = selectedCollectionId ?? undefined;

	// tRPC queries
	const foldersQuery = trpc.folders.useQuery();

	const filterOptionsQuery = trpc.filterOptions.useQuery({
		folder: selectedFolder ?? undefined,
	});

	const photosQuery = trpc.photos.useQuery(
		{
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
		},
		{
			enabled: !searchQuery,
		},
	);

	// Search is scoped by the same folder and EXIF filters as the library.
	const searchPhotosQuery = trpc.searchPhotos.useQuery(
		{
			query: searchQuery,
			limit: 50,
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
		},
		{ enabled: !!searchQuery },
	);

	const similarPhotosQuery = trpc.similarPhotos.useQuery(
		{ photoId: similarSource?.id ?? 0, limit: 60 },
		{ enabled: similarSource !== null },
	);

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
	const activeQuery = similarSource
		? similarPhotosQuery
		: searchQuery
			? searchPhotosQuery
			: photosQuery;
	const photos = activeQuery.data?.photos ?? [];
	const loading = activeQuery.isLoading;
	const error = activeQuery.error;
	const similarNotIndexed =
		similarSource !== null && similarPhotosQuery.data?.indexed === false;

	// State management hooks
	const library = useLibraryState(photos);
	const panels = usePanelState();

	const handleFindSimilar = useCallback(() => {
		const source = library.activePhoto;
		if (!source) return;
		setSearchQuery("");
		setSimilarSource(source);
		library.setViewMode("grid");
	}, [library.activePhoto, library.setViewMode]);

	const exitSimilar = useCallback(() => setSimilarSource(null), []);

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
		setViewMode: library.setViewMode,
		toggleAllPanels: panels.toggleAllPanels,
		toggleFilmstrip: panels.toggleFilmstrip,
		navigatePhoto: library.navigatePhoto,
		hasActivePhoto: library.activePhoto !== null,
		findSimilar: handleFindSimilar,
		exitSimilar: similarSource ? exitSimilar : null,
		curateActivePhoto,
		toggleLastUsedCollection:
			lastUsedCollectionId === null ? null : toggleActiveInLastUsed,
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
		if (query) setSimilarSource(null);
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
	}, []);

	const handleCollectionSelect = useCallback((id: number | null) => {
		// Like folders, a collection scopes an active search; the two are exclusive.
		setSelectedCollectionId(id);
		setSelectedFolder(null);
		setSimilarSource(null);
	}, []);

	const { deleteCollection } = collectionsApi;
	const handleDeleteCollection = useCallback(
		async (id: number) => {
			await deleteCollection(id);
			// Deleting the viewed collection returns to All Photos.
			setSelectedCollectionId((current) => (current === id ? null : current));
		},
		[deleteCollection],
	);

	// Metadata tag chip: filter the library (or the active search) by that tag.
	const { setViewMode } = library;
	const handleTagSelect = useCallback(
		(tag: string) => {
			setFilters((current) => ({ ...current, tag }));
			setSimilarSource(null);
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
	].filter((part): part is string => part !== null);
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
	const banner = similarChip || searchHeader || collectionHeader;

	return (
		<PanelLayout
			toolbar={
				<Toolbar
					viewMode={library.viewMode}
					onViewModeChange={library.setViewMode}
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
							filterOptions={filterOptionsQuery.data}
							activeFilters={filters}
							onFilterChange={setFilters}
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
					collections={{
						collections: collectionsApi.collections,
						onSetMembership: collectionsApi.setMembership,
						onCreate: collectionsApi.createCollection,
						error: collectionsApi.membershipError,
					}}
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
		</PanelLayout>
	);
}
