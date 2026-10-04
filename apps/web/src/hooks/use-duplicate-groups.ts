import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { getMutationKey, getQueryKey } from "@trpc/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { DUPLICATE_PAGE_SIZE } from "@/lib/duplicates";
import { trpc } from "@/lib/trpc";
import type {
	DuplicateGroup,
	DuplicateGroupsResponse,
	DuplicateKind,
} from "@/lib/types";

const GROUPS_KEY = getQueryKey(trpc.duplicateGroups);
const RESOLVE_MUTATION_KEY = getMutationKey(trpc.resolveDuplicateGroup);

/** The badge query caches a plain response; the group list caches pages. */
type CachedGroups =
	| DuplicateGroupsResponse
	| InfiniteData<DuplicateGroupsResponse, string | null>;

function mapPages(
	data: CachedGroups,
	update: (
		page: DuplicateGroupsResponse,
		index: number,
	) => DuplicateGroupsResponse,
): CachedGroups {
	return "pages" in data
		? { ...data, pages: data.pages.map(update) }
		: update(data, 0);
}

/**
 * Re-inserts a rolled-back group at its pre-resolution position while keeping
 * anything resolved (or loaded) since as it currently is.
 */
function restoreGroup(
	current: DuplicateGroupsResponse,
	before: DuplicateGroupsResponse | undefined,
	group: DuplicateGroup,
): DuplicateGroupsResponse {
	const counts = {
		...current.counts,
		[group.kind]: current.counts[group.kind] + 1,
	};
	if (!before) return { ...current, counts };
	const currentKeys = new Set(current.groups.map((g) => g.key));
	const beforeKeys = new Set(before.groups.map((g) => g.key));
	return {
		...current,
		groups: [
			...before.groups.filter(
				(g) => g.key === group.key || currentKeys.has(g.key),
			),
			...current.groups.filter((g) => !beforeKeys.has(g.key)),
		],
		counts,
	};
}

/**
 * Duplicate and burst groups with their resolutions. `counts` (the
 * library-panel badge) is always loaded through a one-group request; the
 * paged group list loads only while the view is open. `resolve` removes the
 * group from every cached list and decrements its kind's count immediately,
 * restores both if the mutation fails (surfacing `error`), and refetches the
 * groups, plus photo lists and junk review after a keep (which rejects the
 * other members), once no resolution is in flight. A `CONFLICT` (membership
 * changed since listing) is not restored: the refetch shows the new group.
 */
export function useDuplicateGroups({
	active,
	kind,
}: {
	active: boolean;
	kind: DuplicateKind | null;
}) {
	const queryClient = useQueryClient();
	const utils = trpc.useUtils();
	const countsQuery = trpc.duplicateGroups.useQuery({ limit: 1 });
	const listQuery = trpc.duplicateGroups.useInfiniteQuery(
		{ kind: kind ?? undefined, limit: DUPLICATE_PAGE_SIZE },
		{ enabled: active, getNextPageParam: (page) => page.nextCursor },
	);
	const { mutateAsync } = trpc.resolveDuplicateGroup.useMutation();
	const [error, setError] = useState<string | null>(null);
	// A keep rejects photos, so library lists need a refresh once settled.
	const libraryStale = useRef(false);

	// Offset pages can overlap after the list shifts; show each group once.
	const pages = listQuery.data?.pages;
	const groups = useMemo(() => {
		const seen = new Set<string>();
		return (pages ?? [])
			.flatMap((page) => page.groups)
			.filter((group) => !seen.has(group.key) && seen.add(group.key));
	}, [pages]);

	/** `keepIds` keeps those members and rejects the rest; null dismisses. */
	const resolve = useCallback(
		(group: DuplicateGroup, keepIds: readonly number[] | null) => {
			setError(null);

			// Stop in-flight group fetches from re-adding the resolved group.
			void queryClient.cancelQueries({ queryKey: GROUPS_KEY });
			const snapshots = queryClient.getQueriesData<CachedGroups>({
				queryKey: GROUPS_KEY,
			});
			queryClient.setQueriesData<CachedGroups>(
				{ queryKey: GROUPS_KEY },
				(data) =>
					data &&
					mapPages(data, (page) => ({
						...page,
						groups: page.groups.filter((g) => g.key !== group.key),
						counts: {
							...page.counts,
							[group.kind]: Math.max(0, page.counts[group.kind] - 1),
						},
					})),
			);
			if (keepIds) libraryStale.current = true;

			mutateAsync(
				keepIds
					? { key: group.key, action: "keep", keepIds: [...keepIds] }
					: { key: group.key, action: "dismiss" },
			)
				.catch((cause: unknown) => {
					console.error("Failed to resolve duplicate group:", cause);
					if (
						cause instanceof TRPCClientError &&
						cause.data?.code === "CONFLICT"
					) {
						// The settle refetch replaces the stale group with its current form.
						setError("This group changed. Showing its current photos.");
						return;
					}
					const rejecting = group.photos.length - (keepIds?.length ?? 0);
					const failed = keepIds
						? `reject ${rejecting === 1 ? "photo" : `${rejecting} photos`}`
						: "dismiss group";
					const message =
						cause instanceof Error ? cause.message : String(cause);
					setError(`Couldn't ${failed}: ${message}`);
					for (const [queryKey, before] of snapshots) {
						if (!before) continue;
						queryClient.setQueryData<CachedGroups>(
							queryKey,
							(current) =>
								current &&
								mapPages(current, (page, index) =>
									restoreGroup(
										page,
										"pages" in before ? before.pages[index] : before,
										group,
									),
								),
						);
					}
				})
				.finally(() => {
					if (
						queryClient.isMutating({ mutationKey: RESOLVE_MUTATION_KEY }) !== 0
					) {
						return;
					}
					void utils.duplicateGroups.invalidate();
					if (libraryStale.current) {
						libraryStale.current = false;
						void utils.photos.invalidate();
						void utils.searchPhotos.invalidate();
						void utils.similarPhotos.invalidate();
						void utils.smartAlbums.invalidate();
						void utils.onThisDay.invalidate();
						// Rejected photos leave junk review.
						void utils.junkReview.invalidate();
					}
				});
		},
		[queryClient, mutateAsync, utils],
	);

	const clearError = useCallback(() => setError(null), []);

	return {
		/** Group counts over the whole library (badge and kind control). */
		counts: pages?.[0]?.counts ?? countsQuery.data?.counts,
		listQuery,
		groups,
		resolve,
		error,
		clearError,
	};
}
