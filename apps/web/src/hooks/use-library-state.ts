import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import { useCallback, useEffect, useState } from "react";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

export type ViewMode = "grid" | "loupe";

interface LibraryState {
	viewMode: ViewMode;
	selectedPhotos: Set<number>;
	activePhoto: PhotoMetadata | null;
	thumbnailSize: number;
	lastSelectedIndex: number | null;
}

const STORAGE_KEY = "photobrain-library-state";

function loadFromStorage(): Partial<LibraryState> {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			return {
				viewMode: parsed.viewMode || "grid",
				thumbnailSize: parsed.thumbnailSize || 200,
			};
		}
	} catch {
		// Ignore errors
	}
	return {};
}

function saveToStorage(state: Partial<LibraryState>) {
	try {
		const current = loadFromStorage();
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				...current,
				viewMode: state.viewMode,
				thumbnailSize: state.thumbnailSize,
			}),
		);
	} catch {
		// Ignore errors
	}
}

export function useLibraryState(photos: PhotoMetadata[] = []) {
	// Load from storage only once on mount using lazy initializer
	const [viewMode, setViewModeInternal] = useState<ViewMode>(
		() => loadFromStorage().viewMode || "grid",
	);
	const [selectedPhotos, setSelectedPhotos] = useState<Set<number>>(new Set());
	const [activePhoto, setActivePhoto] = useState<PhotoMetadata | null>(null);
	const [thumbnailSize, setThumbnailSizeInternal] = useState(
		() => loadFromStorage().thumbnailSize || 200,
	);
	const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(
		null,
	);

	const setViewMode = useCallback((mode: ViewMode) => {
		setViewModeInternal(mode);
		saveToStorage({ viewMode: mode });
	}, []);

	const setThumbnailSize = useCallback((size: number) => {
		setThumbnailSizeInternal(size);
		saveToStorage({ thumbnailSize: size });
	}, []);

	const selectPhoto = useCallback(
		(
			photo: PhotoMetadata,
			options?: { shift?: boolean; ctrl?: boolean; toggle?: boolean },
		) => {
			const photoIndex = photos.findIndex((p) => p.id === photo.id);

			if (options?.shift && lastSelectedIndex !== null) {
				// Range selection
				const start = Math.min(lastSelectedIndex, photoIndex);
				const end = Math.max(lastSelectedIndex, photoIndex);
				const rangeIds = photos.slice(start, end + 1).map((p) => p.id);
				setSelectedPhotos(new Set(rangeIds));
			} else if (options?.ctrl || options?.toggle) {
				// Toggle selection
				setSelectedPhotos((prev) => {
					const next = new Set(prev);
					if (next.has(photo.id)) {
						next.delete(photo.id);
					} else {
						next.add(photo.id);
					}
					return next;
				});
				setLastSelectedIndex(photoIndex);
			} else {
				// Single selection
				setSelectedPhotos(new Set([photo.id]));
				setLastSelectedIndex(photoIndex);
			}

			setActivePhoto(photo);
		},
		[photos, lastSelectedIndex],
	);

	const selectAll = useCallback(() => {
		setSelectedPhotos(new Set(photos.map((p) => p.id)));
	}, [photos]);

	const clearSelection = useCallback(() => {
		setSelectedPhotos(new Set());
		setActivePhoto(null);
		setLastSelectedIndex(null);
	}, []);

	const navigatePhoto = useCallback(
		(direction: "prev" | "next") => {
			if (!activePhoto || photos.length === 0) return;

			const currentIndex = photos.findIndex((p) => p.id === activePhoto.id);
			if (currentIndex === -1) return;

			const newIndex =
				direction === "next"
					? Math.min(currentIndex + 1, photos.length - 1)
					: Math.max(currentIndex - 1, 0);

			const newPhoto = photos[newIndex];
			setActivePhoto(newPhoto);
			setSelectedPhotos(new Set([newPhoto.id]));
			setLastSelectedIndex(newIndex);
		},
		[activePhoto, photos],
	);

	const openInLoupe = useCallback(
		(photo: PhotoMetadata) => {
			setActivePhoto(photo);
			setSelectedPhotos(new Set([photo.id]));
			setViewMode("loupe");
		},
		[setViewMode],
	);

	// When entering loupe mode, ensure we have an active photo
	useEffect(() => {
		if (viewMode === "loupe" && !activePhoto && photos.length > 0) {
			const firstSelected = photos.find((p) => selectedPhotos.has(p.id));
			setActivePhoto(firstSelected || photos[0]);
		}
	}, [viewMode, activePhoto, photos, selectedPhotos]);

	return {
		// View state
		viewMode,
		setViewMode,
		thumbnailSize,
		setThumbnailSize,

		// Selection state
		selectedPhotos,
		activePhoto,
		setActivePhoto,
		selectPhoto,
		selectAll,
		clearSelection,

		// Navigation
		navigatePhoto,
		openInLoupe,

		// Computed
		selectedCount: selectedPhotos.size,
		hasSelection: selectedPhotos.size > 0,
	};
}
