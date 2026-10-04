import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import { useCallback, useEffect, useState } from "react";
import {
	TIMELINE_GROUPINGS,
	TIMELINE_SORTS,
	type TimelineGrouping,
	type TimelineSort,
} from "@/lib/timeline";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

export type ViewMode = "grid" | "loupe" | "map";

interface LibraryState {
	viewMode: ViewMode;
	activePhoto: PhotoMetadata | null;
	thumbnailSize: number;
	grouping: TimelineGrouping;
	sort: TimelineSort;
}

type StoredLibraryState = Partial<
	Pick<LibraryState, "viewMode" | "thumbnailSize" | "grouping" | "sort">
>;

const STORAGE_KEY = "photobrain-library-state";

function loadFromStorage(): StoredLibraryState {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			return {
				viewMode: parsed.viewMode || "grid",
				thumbnailSize: parsed.thumbnailSize || 200,
				grouping: TIMELINE_GROUPINGS.includes(parsed.grouping)
					? parsed.grouping
					: undefined,
				sort: TIMELINE_SORTS.includes(parsed.sort) ? parsed.sort : undefined,
			};
		}
	} catch {
		// Ignore errors
	}
	return {};
}

/** Merges `state` into the stored state, keeping the keys it leaves out. */
function saveToStorage(state: StoredLibraryState) {
	try {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ ...loadFromStorage(), ...state }),
		);
	} catch {
		// Ignore errors
	}
}

/**
 * Library timeline grouping and sort (default months by capture date),
 * persisted with the rest of the library state. Separate from
 * `useLibraryState` because the sorted photo list it produces is what
 * `useLibraryState` navigates.
 */
export function useTimelineSettings() {
	const [grouping, setGroupingInternal] = useState<TimelineGrouping>(
		() => loadFromStorage().grouping ?? "months",
	);
	const [sort, setSortInternal] = useState<TimelineSort>(
		() => loadFromStorage().sort ?? "captured",
	);
	const setGrouping = useCallback((value: TimelineGrouping) => {
		setGroupingInternal(value);
		saveToStorage({ grouping: value });
	}, []);
	const setSort = useCallback((value: TimelineSort) => {
		setSortInternal(value);
		saveToStorage({ sort: value });
	}, []);
	return { grouping, setGrouping, sort, setSort };
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

	/** Applies an in-place update (e.g. rating/flag) to the active photo copy. */
	const patchActivePhoto = useCallback(
		(patch: (photo: PhotoMetadata) => PhotoMetadata) => {
			setActivePhoto((current) => (current ? patch(current) : current));
		},
		[],
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
		patchActivePhoto,
	};
}
