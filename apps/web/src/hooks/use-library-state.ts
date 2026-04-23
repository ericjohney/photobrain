import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import { useCallback, useEffect, useState } from "react";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

export type ViewMode = "grid" | "loupe";

interface LibraryState {
	viewMode: ViewMode;
	activePhoto: PhotoMetadata | null;
	thumbnailSize: number;
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
	const [activePhoto, setActivePhoto] = useState<PhotoMetadata | null>(null);
	const [thumbnailSize, setThumbnailSizeInternal] = useState(
		() => loadFromStorage().thumbnailSize || 200,
	);

	const setViewMode = useCallback((mode: ViewMode) => {
		setViewModeInternal(mode);
		saveToStorage({ viewMode: mode });
	}, []);

	const setThumbnailSize = useCallback((size: number) => {
		setThumbnailSizeInternal(size);
		saveToStorage({ thumbnailSize: size });
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
		},
		[activePhoto, photos],
	);

	const openInLoupe = useCallback(
		(photo: PhotoMetadata) => {
			setActivePhoto(photo);
			setViewMode("loupe");
		},
		[setViewMode],
	);

	// When entering loupe mode, ensure we have an active photo
	useEffect(() => {
		if (viewMode === "loupe" && !activePhoto && photos.length > 0) {
			setActivePhoto(photos[0]);
		}
	}, [viewMode, activePhoto, photos]);

	return {
		viewMode,
		setViewMode,
		thumbnailSize,
		setThumbnailSize,
		activePhoto,
		setActivePhoto,
		navigatePhoto,
		openInLoupe,
	};
}
