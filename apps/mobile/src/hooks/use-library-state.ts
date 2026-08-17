import type { AppRouter } from "@photobrain/api";
import type { inferRouterOutputs } from "@trpc/server";
import { useCallback, useState } from "react";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type PhotoMetadata = RouterOutputs["photos"]["photos"][number];

export type ViewMode = "grid" | "loupe";

export function useLibraryState(photos: PhotoMetadata[] = []) {
	const [viewMode, setViewMode] = useState<ViewMode>("grid");
	const [activePhoto, setActivePhoto] = useState<PhotoMetadata | null>(null);
	const [loupeSession, setLoupeSession] = useState(0);
	const activePhotoIndex = activePhoto
		? photos.findIndex((photo) => photo.id === activePhoto.id)
		: -1;

	const navigatePhoto = useCallback(
		(direction: "prev" | "next") => {
			if (photos.length === 0) return;
			const nextIndex =
				activePhotoIndex === -1
					? direction === "next"
						? 0
						: photos.length - 1
					: direction === "next"
						? Math.min(activePhotoIndex + 1, photos.length - 1)
						: Math.max(activePhotoIndex - 1, 0);
			setActivePhoto(photos[nextIndex] ?? null);
		},
		[activePhotoIndex, photos],
	);

	const navigateToIndex = useCallback(
		(index: number) => {
			if (index >= 0 && index < photos.length) {
				setActivePhoto(photos[index]);
			}
		},
		[photos],
	);

	const openInLoupe = useCallback((photo: PhotoMetadata) => {
		setActivePhoto(photo);
		setLoupeSession((session) => session + 1);
		setViewMode("loupe");
	}, []);

	const closeLoupe = useCallback(() => setViewMode("grid"), []);

	return {
		isLoaded: true,
		viewMode,
		setViewMode,
		activePhoto,
		activePhotoIndex,
		loupeSession,
		setActivePhoto,
		navigatePhoto,
		navigateToIndex,
		openInLoupe,
		closeLoupe,
		hasPrev: activePhotoIndex > 0,
		hasNext: activePhotoIndex >= 0 && activePhotoIndex < photos.length - 1,
		totalPhotos: photos.length,
	};
}
