import { Loader2, Sparkles, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Filmstrip } from "@/components/Filmstrip";
import { LoupeView } from "@/components/LoupeView";
import { PhotoGrid } from "@/components/PhotoGrid";
import { ActivityPanel } from "@/components/panels/ActivityPanel";
import { LibraryPanel } from "@/components/panels/LibraryPanel";
import { MetadataPanel } from "@/components/panels/MetadataPanel";
import { PanelLayout } from "@/components/panels/PanelLayout";
import { Toolbar } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import { useJobProgress } from "@/hooks/use-job-progress";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useLibraryState } from "@/hooks/use-library-state";
import { usePanelState } from "@/hooks/use-panel-state";
import { trpc } from "@/lib/trpc";
import type { PhotoMetadata } from "@/lib/types";

export function Dashboard() {
	const [searchQuery, setSearchQuery] = useState("");
	// Source photo of "More like this" mode; null when browsing the library/search.
	const [similarSource, setSimilarSource] = useState<PhotoMetadata | null>(
		null,
	);
	const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
	const [activeJobId, setActiveJobId] = useState<string | null>(null);
	const [filters, setFilters] = useState<{
		camera: string | null;
		lens: string | null;
		iso: number | null;
		dateMonth: string | null;
	}>({ camera: null, lens: null, iso: null, dateMonth: null });

	// tRPC queries
	const foldersQuery = trpc.folders.useQuery();

	const filterOptionsQuery = trpc.filterOptions.useQuery(
		{ folder: selectedFolder ?? undefined },
		{ enabled: !searchQuery },
	);

	const photosQuery = trpc.photos.useQuery(
		{
			folder: selectedFolder ?? undefined,
			camera: filters.camera ?? undefined,
			lens: filters.lens ?? undefined,
			iso: filters.iso ?? undefined,
			dateMonth: filters.dateMonth ?? undefined,
		},
		{
			enabled: !searchQuery,
		},
	);

	const searchPhotosQuery = trpc.searchPhotos.useQuery(
		{ query: searchQuery, limit: 50 },
		{ enabled: !!searchQuery },
	);

	const similarPhotosQuery = trpc.similarPhotos.useQuery(
		{ photoId: similarSource?.id ?? 0, limit: 60 },
		{ enabled: similarSource !== null },
	);

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
			scanMutation.mutate(force ? { force: true } : undefined);
		},
		[scanMutation, scanDisabled],
	);

	const handleFolderSelect = useCallback((folder: string | null) => {
		setSelectedFolder(folder);
		setSearchQuery(""); // Clear search when selecting folder
		setSimilarSource(null);
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
							searchQuery={searchQuery}
							folders={foldersQuery.data?.folders}
							selectedFolder={selectedFolder}
							onFolderSelect={handleFolderSelect}
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
			{similarChip ? (
				<div className="flex h-full flex-col">
					{similarChip}
					<div className="min-h-0 flex-1">{renderContent()}</div>
				</div>
			) : (
				renderContent()
			)}
		</PanelLayout>
	);
}
