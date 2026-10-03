import { TRPCClientError } from "@trpc/client";
import { useCallback, useState } from "react";
import { trpc } from "@/lib/trpc";

/** Inline-displayable message for a failed collection mutation. */
export function collectionErrorMessage(error: unknown, name?: string) {
	if (error instanceof TRPCClientError && error.data?.code === "CONFLICT") {
		return name
			? `A collection named “${name.trim()}” already exists`
			: "A collection with that name already exists";
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * Collection list, CRUD and membership changes for the dashboard.
 *
 * Membership toggles update the `collectionsForPhoto` cache optimistically and
 * then invalidate `collections` (counts/covers), `collectionsForPhoto`, and the
 * loaded `photos`/`searchPhotos` queries scoped to the changed collection, so a
 * photo removed while viewing that collection leaves the grid. The most
 * recently added-to or created collection is the target of the `B` shortcut.
 */
export function useCollections() {
	const utils = trpc.useUtils();
	const collectionsQuery = trpc.collections.useQuery();
	const [lastUsedCollectionId, setLastUsedCollectionId] = useState<
		number | null
	>(null);
	const [membershipError, setMembershipError] = useState<string | null>(null);

	const createMutation = trpc.createCollection.useMutation();
	const renameMutation = trpc.renameCollection.useMutation();
	const deleteMutation = trpc.deleteCollection.useMutation();
	const addMutation = trpc.addToCollection.useMutation();
	const removeMutation = trpc.removeFromCollection.useMutation();

	const refreshCollection = useCallback(
		(collectionId: number) => {
			void utils.collections.invalidate();
			void utils.collectionsForPhoto.invalidate();
			void utils.photos.invalidate({ collectionId });
			void utils.searchPhotos.invalidate({ collectionId });
		},
		[utils],
	);

	const setMembership = useCallback(
		async (photoId: number, collectionId: number, member: boolean) => {
			setMembershipError(null);
			await utils.collectionsForPhoto.cancel({ photoId });
			utils.collectionsForPhoto.setData({ photoId }, (current) => {
				if (!current) return current;
				const others = current.collectionIds.filter(
					(id) => id !== collectionId,
				);
				return { collectionIds: member ? [...others, collectionId] : others };
			});
			try {
				if (member) {
					await addMutation.mutateAsync({ collectionId, photoIds: [photoId] });
					setLastUsedCollectionId(collectionId);
				} else {
					await removeMutation.mutateAsync({
						collectionId,
						photoIds: [photoId],
					});
				}
			} catch (error) {
				setMembershipError(collectionErrorMessage(error));
			} finally {
				refreshCollection(collectionId);
			}
		},
		[
			utils,
			addMutation.mutateAsync,
			removeMutation.mutateAsync,
			refreshCollection,
		],
	);

	/** `B`: toggles the photo's membership in the last-used collection, if any. */
	const toggleLastUsedCollection = useCallback(
		async (photoId: number) => {
			if (lastUsedCollectionId === null) return;
			let collectionIds: number[];
			try {
				({ collectionIds } = await utils.collectionsForPhoto.ensureData({
					photoId,
				}));
			} catch (error) {
				setMembershipError(collectionErrorMessage(error));
				return;
			}
			await setMembership(
				photoId,
				lastUsedCollectionId,
				!collectionIds.includes(lastUsedCollectionId),
			);
		},
		[lastUsedCollectionId, utils, setMembership],
	);

	/** Creates a collection (optionally with photos); rejects for inline errors. */
	const createCollection = useCallback(
		async (name: string, photoIds?: number[]) => {
			const collection = await createMutation.mutateAsync({ name, photoIds });
			setLastUsedCollectionId(collection.id);
			refreshCollection(collection.id);
			return collection;
		},
		[createMutation.mutateAsync, refreshCollection],
	);

	const renameCollection = useCallback(
		async (id: number, name: string) => {
			await renameMutation.mutateAsync({ id, name });
			void utils.collections.invalidate();
		},
		[renameMutation.mutateAsync, utils],
	);

	const deleteCollection = useCallback(
		async (id: number) => {
			await deleteMutation.mutateAsync({ id });
			setLastUsedCollectionId((current) => (current === id ? null : current));
			refreshCollection(id);
		},
		[deleteMutation.mutateAsync, refreshCollection],
	);

	return {
		collections: collectionsQuery.data?.collections,
		lastUsedCollectionId,
		membershipError,
		setMembership,
		toggleLastUsedCollection,
		createCollection,
		renameCollection,
		deleteCollection,
	};
}
