import type { AppRouter } from "@photobrain/api";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { inferRouterOutputs } from "@trpc/server";
import { useCallback, useEffect, useState } from "react";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

export type ViewMode = "grid" | "loupe";

interface LibraryState {
	viewMode: ViewMode;
	selectedPhotos: Set<number>;
	activePhoto: PhotoMetadata | null;
	activePhotoIndex: number;
}

const STORAGE_KEY = "@photobrain/library-state";

async function loadFromStorage(): Promise<Partial<LibraryState>> {
	try {
		const stored = await AsyncStorage.getItem(STORAGE_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			return {
				viewMode: parsed.viewMode || "grid",
			};
		}
	} catch {
		// Ignore errors
	}
	return {};
}

async function saveToStorage(state: Partial<LibraryState>): Promise<void> {
	try {
		const current = await loadFromStorage();
		await AsyncStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				...current,
				viewMode: state.viewMode,
			}),
		);
	} catch {
		// Ignore errors
	}
}

export function useLibraryState(photos: PhotoMetadata[] = []) {
	const [viewMode, setViewModeInternal] = useState<ViewMode>("grid");
	const [selectedPhotos, setSelectedPhotos] = useState<Set<number>>(new Set());
	const [activePhoto, setActivePhoto] = useState<PhotoMetadata | null>(null);
	const [activePhotoIndex, setActivePhotoIndex] = useState(-1);
	const [isLoaded, setIsLoaded] = useState(false);

	// Load from storage on mount
	useEffect(() => {
		loadFromStorage().then((stored) => {
			if (stored.viewMode) {
				setViewModeInternal(stored.viewMode);
			}
			setIsLoaded(true);
		});
	}, []);

	// Sync active photo index when photos or activePhoto changes
	useEffect(() => {
		if (activePhoto) {
			const index = photos.findIndex((p) => p.id === activePhoto.id);
			setActivePhotoIndex(index);
		} else {
			setActivePhotoIndex(-1);
		}
	}, [activePhoto, photos]);

	const setViewMode = useCallback((mode: ViewMode) => {
		setViewModeInternal(mode);
		saveToStorage({ viewMode: mode });
	}, []);

	const selectPhoto = useCallback(
		(photo: PhotoMetadata, options?: { toggle?: boolean }) => {
			if (options?.toggle) {
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
			} else {
				// Single selection
				setSelectedPhotos(new Set([photo.id]));
			}
			setActivePhoto(photo);
		},
		[],
	);

	const selectAll = useCallback(() => {
		setSelectedPhotos(new Set(photos.map((p) => p.id)));
	}, [photos]);

	const clearSelection = useCallback(() => {
		setSelectedPhotos(new Set());
		setActivePhoto(null);
	}, []);

	const navigatePhoto = useCallback(
		(direction: "prev" | "next") => {
			if (photos.length === 0) return;

			let newIndex: number;
			if (activePhotoIndex === -1) {
				// No active photo, start from beginning or end
				newIndex = direction === "next" ? 0 : photos.length - 1;
			} else {
				newIndex =
					direction === "next"
						? Math.min(activePhotoIndex + 1, photos.length - 1)
						: Math.max(activePhotoIndex - 1, 0);
			}

			const newPhoto = photos[newIndex];
			if (newPhoto) {
				setActivePhoto(newPhoto);
				setSelectedPhotos(new Set([newPhoto.id]));
			}
		},
		[activePhotoIndex, photos],
	);

	const navigateToIndex = useCallback(
		(index: number) => {
			if (index >= 0 && index < photos.length) {
				const photo = photos[index];
				setActivePhoto(photo);
				setSelectedPhotos(new Set([photo.id]));
			}
		},
		[photos],
	);

	const openInLoupe = useCallback(
		(photo: PhotoMetadata) => {
			setActivePhoto(photo);
			setSelectedPhotos(new Set([photo.id]));
			setViewMode("loupe");
		},
		[setViewMode],
	);

	const closeLoupe = useCallback(() => {
		setViewMode("grid");
	}, [setViewMode]);

	// Navigation helpers
	const hasPrev = activePhotoIndex > 0;
	const hasNext = activePhotoIndex < photos.length - 1 && activePhotoIndex >= 0;

	return {
		// Loading state
		isLoaded,

		// View state
		viewMode,
		setViewMode,

		// Selection state
		selectedPhotos,
		activePhoto,
		activePhotoIndex,
		setActivePhoto,
		selectPhoto,
		selectAll,
		clearSelection,

		// Navigation
		navigatePhoto,
		navigateToIndex,
		openInLoupe,
		closeLoupe,
		hasPrev,
		hasNext,

		// Computed
		selectedCount: selectedPhotos.size,
		hasSelection: selectedPhotos.size > 0,
		totalPhotos: photos.length,
	};
}
