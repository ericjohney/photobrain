import { useQueryClient } from "@tanstack/react-query";
import { getMutationKey, getQueryKey } from "@trpc/react-query";
import { useCallback, useRef, useState } from "react";
import { REVIEW_PAGE_SIZE } from "@/lib/junk-review";
import { trpc } from "@/lib/trpc";
import type {
	JunkAction,
	JunkCounts,
	JunkReason,
	JunkReviewResponse,
	ReviewPhoto,
} from "@/lib/types";

const REVIEW_KEY = getQueryKey(trpc.junkReview);
const RESOLVE_MUTATION_KEY = getMutationKey(trpc.resolveJunk);

/** Candidate counts contributed by `photos` (a photo counts once per reason). */
function countReasons(photos: readonly ReviewPhoto[]): JunkCounts {
	const counts: JunkCounts = {
		all: photos.length,
		screenshot: 0,
		document: 0,
		blurry: 0,
		dark: 0,
	};
	for (const photo of photos) {
		for (const reason of photo.junkReasons) counts[reason]++;
	}
	return counts;
}

function shiftCounts(
	counts: JunkCounts,
	delta: JunkCounts,
	sign: 1 | -1,
): JunkCounts {
	const shift = (value: number, by: number) => Math.max(0, value + sign * by);
	return {
		all: shift(counts.all, delta.all),
		screenshot: shift(counts.screenshot, delta.screenshot),
		document: shift(counts.document, delta.document),
		blurry: shift(counts.blurry, delta.blurry),
		dark: shift(counts.dark, delta.dark),
	};
}

/**
 * Re-inserts rolled-back photos at their pre-resolution positions while
 * keeping anything resolved since (or loaded since) as it currently is.
 */
function restorePhotos(
	current: JunkReviewResponse,
	before: JunkReviewResponse,
	ids: ReadonlySet<number>,
	delta: JunkCounts,
): JunkReviewResponse {
	const currentIds = new Set(current.photos.map((photo) => photo.id));
	const beforeIds = new Set(before.photos.map((photo) => photo.id));
	return {
		...current,
		photos: [
			...before.photos.filter(
				(photo) => ids.has(photo.id) || currentIds.has(photo.id),
			),
			...current.photos.filter((photo) => !beforeIds.has(photo.id)),
		],
		counts: shiftCounts(current.counts, delta, 1),
	};
}

/**
 * Junk review data and actions. `counts` (the library-panel badge) is always
 * loaded through a one-photo request; the candidate list loads only while
 * Review is open. `resolve` removes photos from every cached review list and
 * decrements the counts immediately, restores both if the mutation fails
 * (surfacing `error`), and refetches review lists, plus photo lists after a
 * reject, once no resolution is in flight.
 */
export function useJunkReview({
	active,
	reason,
}: {
	active: boolean;
	reason: JunkReason | null;
}) {
	const queryClient = useQueryClient();
	const utils = trpc.useUtils();
	const countsQuery = trpc.junkReview.useQuery({ limit: 1 });
	const listQuery = trpc.junkReview.useQuery(
		{ reason: reason ?? undefined, limit: REVIEW_PAGE_SIZE },
		{ enabled: active },
	);
	const { mutateAsync } = trpc.resolveJunk.useMutation();
	const [error, setError] = useState<string | null>(null);
	// A reject changes photo flags, so library lists need a refresh once settled.
	const libraryStale = useRef(false);

	const resolve = useCallback(
		(targets: readonly ReviewPhoto[], action: JunkAction) => {
			if (targets.length === 0) return;
			const ids = new Set(targets.map((photo) => photo.id));
			const delta = countReasons(targets);
			setError(null);

			// Stop in-flight review fetches from re-adding the resolved photos.
			void queryClient.cancelQueries({ queryKey: REVIEW_KEY });
			const snapshots = queryClient.getQueriesData<JunkReviewResponse>({
				queryKey: REVIEW_KEY,
			});
			queryClient.setQueriesData<JunkReviewResponse>(
				{ queryKey: REVIEW_KEY },
				(data) =>
					data && {
						...data,
						photos: data.photos.filter((photo) => !ids.has(photo.id)),
						counts: shiftCounts(data.counts, delta, -1),
					},
			);
			if (action === "reject") libraryStale.current = true;

			mutateAsync({ photoIds: [...ids], action })
				.catch((cause: unknown) => {
					console.error("Failed to resolve review photos:", cause);
					const count = ids.size === 1 ? "photo" : `${ids.size} photos`;
					const message =
						cause instanceof Error ? cause.message : String(cause);
					setError(`Couldn't ${action} ${count}: ${message}`);
					for (const [queryKey, before] of snapshots) {
						if (!before) continue;
						queryClient.setQueryData<JunkReviewResponse>(
							queryKey,
							(current) =>
								current && restorePhotos(current, before, ids, delta),
						);
					}
				})
				.finally(() => {
					if (
						queryClient.isMutating({ mutationKey: RESOLVE_MUTATION_KEY }) !== 0
					) {
						return;
					}
					void utils.junkReview.invalidate();
					if (libraryStale.current) {
						libraryStale.current = false;
						void utils.photos.invalidate();
						void utils.searchPhotos.invalidate();
						void utils.similarPhotos.invalidate();
						void utils.smartAlbums.invalidate();
						void utils.onThisDay.invalidate();
						// Rejected photos leave duplicate and burst groups.
						void utils.duplicateGroups.invalidate();
					}
				});
		},
		[queryClient, mutateAsync, utils],
	);

	const clearError = useCallback(() => setError(null), []);

	return {
		/** Candidate counts over the whole library (badge and reason control). */
		counts: listQuery.data?.counts ?? countsQuery.data?.counts,
		listQuery,
		photos: listQuery.data?.photos ?? [],
		resolve,
		error,
		clearError,
	};
}
