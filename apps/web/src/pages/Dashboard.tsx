import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Filmstrip } from "@/components/Filmstrip";
import { LoupeView } from "@/components/LoupeView";
import { PhotoGrid } from "@/components/PhotoGrid";
import { LibraryPanel } from "@/components/panels/LibraryPanel";
import { MetadataPanel } from "@/components/panels/MetadataPanel";
import { PanelLayout } from "@/components/panels/PanelLayout";
import { Toolbar } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useLibraryState } from "@/hooks/use-library-state";
import { usePanelState } from "@/hooks/use-panel-state";
import { trpc } from "@/lib/trpc";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

export function Dashboard() {
	const [searchQuery, setSearchQuery] = useState("");

	// tRPC queries
	const photosQuery = trpc.photos.useQuery(undefined, {
		enabled: !searchQuery,
	});

	const searchPhotosQuery = trpc.searchPhotos.useQuery(
		{ query: searchQuery, limit: 50 },
		{ enabled: !!searchQuery },
	);

	const scanMutation = trpc.scan.useMutation({
		onSuccess: () => {
			photosQuery.refetch();
			if (searchQuery) {
				searchPhotosQuery.refetch();
			}
		},
	});

	// Determine which data to use
	const photosData = searchQuery ? searchPhotosQuery.data : photosQuery.data;
	const photos = photosData?.photos ?? [];
	const loading = searchQuery
		? searchPhotosQuery.isLoading
		: photosQuery.isLoading;
	const error = searchQuery ? searchPhotosQuery.error : photosQuery.error;

	// State management hooks
	const library = useLibraryState(photos);
	const panels = usePanelState();

	// Keyboard shortcuts
	useKeyboardShortcuts({
		viewMode: library.viewMode,
		setViewMode: library.setViewMode,
		toggleAllPanels: panels.toggleAllPanels,
		toggleFilmstrip: panels.toggleFilmstrip,
		navigatePhoto: library.navigatePhoto,
		clearSelection: library.clearSelection,
		selectAll: library.selectAll,
		hasActivePhoto: library.activePhoto !== null,
	});

	const handlePhotoClick = useCallback(
		(photo: PhotoMetadata, event: React.MouseEvent) => {
			library.selectPhoto(photo, {
				shift: event.shiftKey,
				ctrl: event.ctrlKey || event.metaKey,
			});
		},
		[library],
	);

	const handlePhotoDoubleClick = useCallback(
		(photo: PhotoMetadata) => {
			library.openInLoupe(photo);
		},
		[library],
	);

	const handleFilmstripClick = useCallback(
		(photo: PhotoMetadata) => {
			library.selectPhoto(photo);
		},
		[library],
	);

	const handleSearch = useCallback(() => {
		// Query is reactive, nothing needed here
	}, []);

	const handleRefresh = useCallback(() => {
		setSearchQuery("");
		scanMutation.mutate();
	}, [scanMutation]);

	// Navigation helpers for loupe
	const currentIndex = library.activePhoto
		? photos.findIndex((p) => p.id === library.activePhoto?.id)
		: -1;
	const hasPrev = currentIndex > 0;
	const hasNext = currentIndex < photos.length - 1;

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
							onClick={handleRefresh}
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

		return (
			<PhotoGrid
				photos={photos}
				selectedPhotos={library.selectedPhotos}
				activePhotoId={library.activePhoto?.id}
				thumbnailSize={library.thumbnailSize}
				onPhotoClick={handlePhotoClick}
				onPhotoDoubleClick={handlePhotoDoubleClick}
			/>
		);
	};

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
					onSearchChange={setSearchQuery}
					onSearch={handleSearch}
					onRefresh={handleRefresh}
					isRefreshing={scanMutation.isPending}
					photoCount={photos.length}
					selectedCount={library.selectedCount}
				/>
			}
			leftPanel={
				<LibraryPanel photoCount={photos.length} searchQuery={searchQuery} />
			}
			rightPanel={<MetadataPanel photo={library.activePhoto} />}
			filmstrip={
				<Filmstrip
					photos={photos}
					activePhotoId={library.activePhoto?.id}
					selectedPhotos={library.selectedPhotos}
					onPhotoClick={handleFilmstripClick}
				/>
			}
			leftPanelVisible={panels.leftPanelVisible}
			rightPanelVisible={panels.rightPanelVisible}
			filmstripVisible={panels.filmstripVisible}
		>
			{renderContent()}
		</PanelLayout>
	);
}
