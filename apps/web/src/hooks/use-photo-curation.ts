import { useQueryClient } from "@tanstack/react-query";
import { getMutationKey, getQueryKey } from "@trpc/react-query";
import { useCallback } from "react";
import { trpc } from "@/lib/trpc";
import type { PhotoFlag, PhotoMetadata } from "@/lib/types";

/** Rating (0-5) and/or flag change; omitted keys are left untouched. */
export type CurationPatch = { rating?: number; flag?: PhotoFlag | null };

type CurationFields = Pick<PhotoMetadata, "rating" | "flag">;
type CuratedPhoto = Pick<PhotoMetadata, "id"> & CurationFields;

/** Pure photo transform applied to cached lists and the active photo alike. */
export type PhotoPatcher = <T extends CuratedPhoto>(photo: T) => T;

/** Every cached photo list that can render a curated photo. */
const PHOTO_LIST_KEYS = [
	getQueryKey(trpc.photos),
	getQueryKey(trpc.searchPhotos),
	getQueryKey(trpc.similarPhotos),
];
const CURATION_MUTATION_KEY = getMutationKey(trpc.setPhotoCuration);

function matchesPatch(photo: CurationFields, patch: CurationPatch) {
	return (
		(patch.rating === undefined || photo.rating === patch.rating) &&
		(patch.flag === undefined || photo.flag === patch.flag)
	);
}

/**
 * Optimistic rating/flag updates. The patch is applied synchronously to every
 * loaded `photos`, `searchPhotos`, and `similarPhotos` query plus `onPatch`
 * (for state holding its own photo copy); a failed mutation restores the
 * previous values, and the lists are refetched once no curation is in flight.
 */
export function usePhotoCuration(onPatch: (patcher: PhotoPatcher) => void) {
	const queryClient = useQueryClient();
	const { mutateAsync } = trpc.setPhotoCuration.useMutation();

	const patchEverywhere = useCallback(
		(patcher: PhotoPatcher) => {
			for (const queryKey of PHOTO_LIST_KEYS) {
				queryClient.setQueriesData<{ photos: CuratedPhoto[] }>(
					{ queryKey },
					(data) => {
						if (!data) return data;
						let changed = false;
						const photos = data.photos.map((photo) => {
							const next = patcher(photo);
							if (next !== photo) changed = true;
							return next;
						});
						return changed ? { ...data, photos } : data;
					},
				);
			}
			onPatch(patcher);
		},
		[queryClient, onPatch],
	);

	const setCuration = useCallback(
		(targets: readonly CuratedPhoto[], patch: CurationPatch) => {
			const changing = targets.filter((photo) => !matchesPatch(photo, patch));
			if (changing.length === 0) return;
			const previous = new Map<number, CurationFields>(
				changing.map(({ id, rating, flag }) => [id, { rating, flag }]),
			);

			// Stop in-flight list fetches from overwriting the optimistic values.
			for (const queryKey of PHOTO_LIST_KEYS) {
				void queryClient.cancelQueries({ queryKey });
			}
			patchEverywhere((photo) =>
				previous.has(photo.id) ? { ...photo, ...patch } : photo,
			);

			mutateAsync({ photoIds: [...previous.keys()], ...patch })
				.catch((error: unknown) => {
					console.error("Failed to update rating/flag:", error);
					// Restore only values still showing this patch, so a newer
					// curation of the same photo is not clobbered.
					patchEverywhere((photo) => {
						const prior = previous.get(photo.id);
						if (!prior || !matchesPatch(photo, patch)) return photo;
						return {
							...photo,
							...(patch.rating !== undefined && { rating: prior.rating }),
							...(patch.flag !== undefined && { flag: prior.flag }),
						};
					});
				})
				.finally(() => {
					if (
						queryClient.isMutating({ mutationKey: CURATION_MUTATION_KEY }) === 0
					) {
						for (const queryKey of PHOTO_LIST_KEYS) {
							void queryClient.invalidateQueries({ queryKey });
						}
					}
				});
		},
		[queryClient, mutateAsync, patchEverywhere],
	);

	return { setCuration };
}
