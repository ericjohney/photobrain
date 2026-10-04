import { TRPCClientError } from "@trpc/client";
import { useCallback } from "react";
import {
	EMPTY_LIBRARY_FILTERS,
	type LibraryFilters,
} from "@/components/panels/LibraryPanel";
import { trpc } from "@/lib/trpc";
import type { SmartAlbum, SmartAlbumFilters } from "@/lib/types";

/** Inline-displayable message for a failed smart album mutation. */
export function smartAlbumErrorMessage(error: unknown, name?: string) {
	if (error instanceof TRPCClientError && error.data?.code === "CONFLICT") {
		return name
			? `A smart album named “${name.trim()}” already exists`
			: "A smart album with that name already exists";
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Saved form of the dashboard's folder + library filters. The collection and
 * the map-area `bounds` are never saved (the API rejects both), so a map area
 * alone is not savable and is ignored alongside other filters.
 */
export function toSmartAlbumFilters(
	folder: string | null,
	filters: LibraryFilters,
): SmartAlbumFilters {
	return {
		...(filters.filterRaw !== "all" && { filterRaw: filters.filterRaw }),
		...(folder !== null && { folder }),
		...(filters.camera !== null && { camera: filters.camera }),
		...(filters.lens !== null && { lens: filters.lens }),
		...(filters.iso !== null && { iso: filters.iso }),
		...(filters.dateMonth !== null && { dateMonth: filters.dateMonth }),
		...(filters.minRating !== null && { minRating: filters.minRating }),
		...(filters.flag !== null && { flag: filters.flag }),
		...(filters.tag !== null && { tag: filters.tag }),
		...(filters.country !== null && { country: filters.country }),
		...(filters.place !== null && { place: filters.place }),
	};
}

/** Library filters restored from a smart album (the folder is separate state). */
export function fromSmartAlbumFilters(
	filters: SmartAlbumFilters,
): LibraryFilters {
	return {
		...EMPTY_LIBRARY_FILTERS,
		filterRaw: filters.filterRaw ?? "all",
		camera: filters.camera ?? null,
		lens: filters.lens ?? null,
		iso: filters.iso ?? null,
		dateMonth: filters.dateMonth ?? null,
		minRating: filters.minRating ?? null,
		flag: filters.flag ?? null,
		tag: filters.tag ?? null,
		country: filters.country ?? null,
		place: filters.place ?? null,
	};
}

/** Whether the dashboard's folder, filters, and query equal the album's saved ones. */
export function smartAlbumMatches(
	album: SmartAlbum,
	filters: SmartAlbumFilters,
	query: string | null,
) {
	const saved = toSmartAlbumFilters(
		album.filters.folder ?? null,
		fromSmartAlbumFilters(album.filters),
	);
	const savedKeys = Object.keys(saved) as (keyof SmartAlbumFilters)[];
	return (
		album.query === query &&
		savedKeys.length === Object.keys(filters).length &&
		savedKeys.every((key) => saved[key] === filters[key])
	);
}

/**
 * Smart album list and CRUD for the dashboard. Albums are evaluated live by
 * the API, so mutations only refresh the `smartAlbums` list; scans, curation,
 * and junk rejections invalidate it alongside the photo lists they change.
 */
export function useSmartAlbums() {
	const utils = trpc.useUtils();
	const albumsQuery = trpc.smartAlbums.useQuery();
	const createMutation = trpc.createSmartAlbum.useMutation();
	const updateMutation = trpc.updateSmartAlbum.useMutation();
	const deleteMutation = trpc.deleteSmartAlbum.useMutation();

	/** Saves filters + optional query under `name`; rejects for inline errors. */
	const createSmartAlbum = useCallback(
		async (name: string, filters: SmartAlbumFilters, query: string | null) => {
			const album = await createMutation.mutateAsync({
				name,
				filters,
				...(query !== null && { query }),
			});
			// Wait for the refetch so the new album is listed before it is selected.
			await utils.smartAlbums.invalidate();
			return album;
		},
		[createMutation.mutateAsync, utils],
	);

	const renameSmartAlbum = useCallback(
		async (id: number, name: string) => {
			await updateMutation.mutateAsync({ id, name });
			void utils.smartAlbums.invalidate();
		},
		[updateMutation.mutateAsync, utils],
	);

	const deleteSmartAlbum = useCallback(
		async (id: number) => {
			await deleteMutation.mutateAsync({ id });
			void utils.smartAlbums.invalidate();
		},
		[deleteMutation.mutateAsync, utils],
	);

	return {
		albums: albumsQuery.data?.albums,
		createSmartAlbum,
		renameSmartAlbum,
		deleteSmartAlbum,
	};
}
