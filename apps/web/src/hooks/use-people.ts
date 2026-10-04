import { hashKey, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { useCallback, useState } from "react";
import { trpc } from "@/lib/trpc";
import type { Person, PhotoFace } from "@/lib/types";

const PEOPLE_KEY = getQueryKey(trpc.people);
const PERSON_KEY = getQueryKey(trpc.person);
// The "Show hidden" list's exact key; lists without hidden people drop them.
const HIDDEN_PEOPLE_HASH = hashKey(
	getQueryKey(trpc.people, { includeHidden: true }, "query"),
);

type PeopleResponse = { people: Person[] };
type PhotoFacesResponse = { faces: PhotoFace[] };

/** "Unnamed" for people without a name. */
export function personName(person: Pick<Person, "name">) {
	return person.name ?? "Unnamed";
}

/**
 * People list (badge and People view) plus optimistic person mutations.
 * The badge counts visible people from the `people()` query; the view lists
 * `people({ includeHidden: true })` while "Show hidden" is on. Every mutation
 * patches the cached `people`/`person` queries first, restores the snapshots
 * if the API fails (surfacing `error`), and then invalidates people, person,
 * photo faces, and photo lists (person-scoped listings change on merges).
 */
export function usePeople({
	active,
	includeHidden,
}: {
	active: boolean;
	includeHidden: boolean;
}) {
	const queryClient = useQueryClient();
	const utils = trpc.useUtils();
	const visibleQuery = trpc.people.useQuery(undefined);
	const hiddenQuery = trpc.people.useQuery(
		{ includeHidden: true },
		{ enabled: active && includeHidden },
	);
	const listQuery = includeHidden ? hiddenQuery : visibleQuery;
	const updateMutation = trpc.updatePerson.useMutation();
	const mergeMutation = trpc.mergePeople.useMutation();
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(() => {
		void utils.people.invalidate();
		void utils.person.invalidate();
		void utils.photoFaces.invalidate();
		void utils.photos.invalidate();
		void utils.searchPhotos.invalidate();
	}, [utils]);

	/**
	 * Applies `patch` to every cached people list and person, runs `mutate`,
	 * and restores the snapshots when it fails.
	 */
	const optimistic = useCallback(
		async (
			patch: {
				list: (people: Person[], withHidden: boolean) => Person[];
				person: (person: Person) => Person | undefined;
			},
			mutate: () => Promise<unknown>,
			failure: string,
		) => {
			setError(null);
			await Promise.all([
				queryClient.cancelQueries({ queryKey: PEOPLE_KEY }),
				queryClient.cancelQueries({ queryKey: PERSON_KEY }),
			]);
			const lists = queryClient.getQueriesData<PeopleResponse>({
				queryKey: PEOPLE_KEY,
			});
			const people = queryClient.getQueriesData<Person>({
				queryKey: PERSON_KEY,
			});
			for (const [queryKey, data] of lists) {
				if (!data) continue;
				queryClient.setQueryData<PeopleResponse>(queryKey, {
					...data,
					people: patch.list(
						data.people,
						hashKey(queryKey) === HIDDEN_PEOPLE_HASH,
					),
				});
			}
			for (const [queryKey, data] of people) {
				if (data) queryClient.setQueryData(queryKey, patch.person(data));
			}
			try {
				await mutate();
			} catch (cause) {
				console.error(`${failure}:`, cause);
				setError(
					`${failure}: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
				for (const [queryKey, data] of [...lists, ...people]) {
					queryClient.setQueryData(queryKey, data);
				}
			} finally {
				refresh();
			}
		},
		[queryClient, refresh],
	);

	const { mutateAsync: updatePerson } = updateMutation;
	const rename = useCallback(
		(person: Person, name: string | null) => {
			const update = (p: Person) => (p.id === person.id ? { ...p, name } : p);
			return optimistic(
				{
					list: (people) => people.map(update),
					person: update,
				},
				() => updatePerson({ id: person.id, name }),
				`Couldn't rename ${personName(person)}`,
			);
		},
		[optimistic, updatePerson],
	);

	const setHidden = useCallback(
		(person: Person, hidden: boolean) => {
			const update = (p: Person) =>
				p.id === person.id ? { ...p, hidden } : p;
			return optimistic(
				{
					// Lists without hidden people drop a hidden one (and regain an
					// unhidden one on refetch).
					list: (people, withHidden) =>
						people
							.map(update)
							.filter((p) => withHidden || !p.hidden),
					person: update,
				},
				() => updatePerson({ id: person.id, hidden }),
				`Couldn't ${hidden ? "hide" : "unhide"} ${personName(person)}`,
			);
		},
		[optimistic, updatePerson],
	);

	const { mutateAsync: mergePeople } = mergeMutation;
	/** Moves every face of `sources` to `target`; an unnamed target takes the first source name. */
	const merge = useCallback(
		(target: Person, sources: readonly Person[]) => {
			const sourceIds = new Set(sources.map((p) => p.id));
			const name =
				target.name ?? sources.find((p) => p.name !== null)?.name ?? null;
			const faceCount =
				target.faceCount + sources.reduce((sum, p) => sum + p.faceCount, 0);
			const update = (p: Person) =>
				p.id === target.id ? { ...p, name, faceCount } : p;
			return optimistic(
				{
					list: (people) =>
						people.filter((p) => !sourceIds.has(p.id)).map(update),
					person: (p) => (sourceIds.has(p.id) ? undefined : update(p)),
				},
				() =>
					mergePeople({
						targetId: target.id,
						sourceIds: sources.map((p) => p.id),
					}),
				`Couldn't merge into ${personName(target)}`,
			);
		},
		[optimistic, mergePeople],
	);

	const clearError = useCallback(() => setError(null), []);

	return {
		/** Visible people (the Catalog badge); undefined until loaded. */
		count: visibleQuery.data?.people.length,
		listQuery,
		people: listQuery.data?.people ?? [],
		rename,
		setHidden,
		merge,
		error,
		clearError,
	};
}

/** What an assign-face choice sends (exactly one of `personId`/`name`). */
export type FaceAssignment =
	| { personId: number; personName: string | null }
	| { name: string }
	| { personId: null };

/**
 * Optimistic `assignFace` for one photo's faces: the `photoFaces` cache is
 * patched immediately, restored on failure (surfacing `error`), and people,
 * person, photo faces, and photo lists are invalidated once settled.
 */
export function useAssignFace(photoId: number) {
	const utils = trpc.useUtils();
	const { mutateAsync } = trpc.assignFace.useMutation();
	const [error, setError] = useState<string | null>(null);

	const assign = useCallback(
		async (face: PhotoFace, assignment: FaceAssignment) => {
			setError(null);
			await utils.photoFaces.cancel({ photoId });
			const before = utils.photoFaces.getData({ photoId });
			const next: Pick<PhotoFace, "personId" | "personName" | "assignment"> =
				"name" in assignment
					? { personId: null, personName: assignment.name, assignment: "manual" }
					: assignment.personId === null
						? { personId: null, personName: null, assignment: "rejected" }
						: {
								personId: assignment.personId,
								personName: assignment.personName,
								assignment: "manual",
							};
			utils.photoFaces.setData(
				{ photoId },
				(current: PhotoFacesResponse | undefined) =>
					current && {
						faces: current.faces.map((f) =>
							f.id === face.id ? { ...f, ...next } : f,
						),
					},
			);
			try {
				await mutateAsync(
					"name" in assignment
						? { faceId: face.id, name: assignment.name }
						: { faceId: face.id, personId: assignment.personId },
				);
			} catch (cause) {
				console.error("Failed to assign face:", cause);
				setError(
					`Couldn't update this face: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
				utils.photoFaces.setData({ photoId }, before);
			} finally {
				void utils.photoFaces.invalidate();
				void utils.people.invalidate();
				void utils.person.invalidate();
				void utils.photos.invalidate();
				void utils.searchPhotos.invalidate();
			}
		},
		[utils, photoId, mutateAsync],
	);

	return { assign, error };
}
