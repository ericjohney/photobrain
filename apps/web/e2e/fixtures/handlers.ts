import type { Page, Route } from "@playwright/test";
import superjson, { type SuperJSONResult } from "superjson";
import { TINY_JPEG_BYTES, TINY_WEBP_BYTES } from "./images";
import {
	FIXTURE_DUPLICATE_GROUPS,
	FIXTURE_FOLDERS,
	FIXTURE_JUNK_REASONS,
	FIXTURE_PHOTO_PLACES,
	FIXTURE_PHOTO_TAGS,
	FIXTURE_PHOTOS,
	type FixtureDuplicateKind,
	type FixtureJunkReason,
	type FixturePhoto,
	type FixturePhotoFilters,
	filterFixturePhotos,
	fixtureLocation,
	fixturePlaceOptions,
	fixtureTagCounts,
	searchPhotosByQuery,
} from "./photos";

function parseTrpcBatchRequest(
	url: URL,
	method: string,
	postData: string | null,
) {
	const pathSegments = url.pathname.replace(/^.*\/trpc\//, "").split(",");
	const inputParam = url.searchParams.get("input");
	const inputs: Record<string, SuperJSONResult> = inputParam
		? JSON.parse(inputParam)
		: {};
	const body: Record<string, SuperJSONResult> =
		method === "POST" && postData ? JSON.parse(postData) : {};
	return pathSegments.map((path, i) => {
		const key = i.toString();
		const serializedInput = inputs[key] ?? body[key];
		return {
			path,
			input: serializedInput
				? superjson.deserialize(serializedInput)
				: undefined,
		};
	});
}

/** Overrides also receive the page's default handlers, to delegate to them. */
type Handler = (
	input: unknown,
	defaults: Record<string, Handler>,
) => unknown | Promise<unknown>;

export type HandlerOverrides = Partial<Record<string, Handler>>;

export const FIXTURE_JOB_ID = "11111111-1111-4111-8111-111111111111";

const TRPC_ERROR_CODES = {
	BAD_REQUEST: { code: -32600, httpStatus: 400 },
	NOT_FOUND: { code: -32004, httpStatus: 404 },
	CONFLICT: { code: -32009, httpStatus: 409 },
	INTERNAL_SERVER_ERROR: { code: -32603, httpStatus: 500 },
} as const;

/** Thrown by a handler to answer with a typed tRPC error instead of a 500. */
export class TrpcFixtureError extends Error {
	constructor(
		readonly code: keyof typeof TRPC_ERROR_CODES,
		message: string,
	) {
		super(message);
	}
}

type CurationInput = {
	photoIds: number[];
	rating?: number;
	flag?: FixturePhoto["flag"];
};

/** Optional collection scope accepted by photos, searchPhotos and similarPhotos. */
type CollectionScope = { collectionId?: number };

type FixtureCollection = {
	id: number;
	name: string;
	createdAt: Date;
	updatedAt: Date;
	/** Member photo IDs in the order they were added (last = cover). */
	photoIds: number[];
};

type FixtureSmartAlbumFilters = Omit<FixturePhotoFilters, "filterRaw"> & {
	filterRaw?: "raw" | "standard";
};

type FixtureSmartAlbum = {
	id: number;
	name: string;
	filters: FixtureSmartAlbumFilters;
	query: string | null;
	createdAt: Date;
	updatedAt: Date;
};

/**
 * Builds handlers over a private copy of the fixture library and an empty
 * collection store, so writes (`setPhotoCuration`, collection mutations) are
 * visible to later reads on the same page.
 */
function createDefaultHandlers(): Record<string, Handler> {
	const library = FIXTURE_PHOTOS.map((photo) => ({ ...photo }));
	const collections = new Map<number, FixtureCollection>();
	let nextCollectionId = 1;
	// Photos kept from junk review (the API's photos.junk_dismissed).
	const junkDismissed = new Set<number>();
	// Group keys marked "Not duplicates" (the API's duplicate_dismissals).
	const duplicateDismissals = new Set<string>();
	// Strictly increasing so same-millisecond writes still order deterministically.
	let clock = Date.parse("2024-09-01T00:00:00Z");
	const now = () => {
		clock += 1000;
		return new Date(clock);
	};

	const collectionDto = (collection: FixtureCollection) => {
		const coverId = collection.photoIds.at(-1);
		return {
			id: collection.id,
			name: collection.name,
			photoCount: collection.photoIds.length,
			cover:
				coverId === undefined
					? null
					: { photoId: coverId, thumbnailUpdatedAt: null },
			createdAt: collection.createdAt,
			updatedAt: collection.updatedAt,
		};
	};
	const findCollection = (id: number) => {
		const collection = collections.get(id);
		if (!collection) {
			throw new TrpcFixtureError("NOT_FOUND", "Collection not found");
		}
		return collection;
	};
	const smartAlbums = new Map<number, FixtureSmartAlbum>();
	let nextSmartAlbumId = 1;
	/** Live evaluation like the API: query albums have no count or cover. */
	const smartAlbumDto = (album: FixtureSmartAlbum) => {
		const matching =
			album.query === null ? filterFixturePhotos(library, album.filters) : null;
		const coverId = matching?.reduce<number | undefined>(
			(max, p) => (max === undefined || p.id > max ? p.id : max),
			undefined,
		);
		return {
			id: album.id,
			name: album.name,
			filters: album.filters,
			query: album.query,
			photoCount: matching?.length ?? null,
			cover:
				coverId === undefined
					? null
					: { photoId: coverId, thumbnailUpdatedAt: null },
			createdAt: album.createdAt,
			updatedAt: album.updatedAt,
		};
	};
	const findSmartAlbum = (id: number) => {
		const album = smartAlbums.get(id);
		if (!album) {
			throw new TrpcFixtureError("NOT_FOUND", "Smart album not found");
		}
		return album;
	};
	const checkedSmartAlbumName = (name: string, exceptId?: number) => {
		const trimmed = name.trim();
		if (trimmed.length < 1 || trimmed.length > 100) {
			throw new TrpcFixtureError("BAD_REQUEST", "Invalid smart album name");
		}
		for (const other of smartAlbums.values()) {
			if (
				other.id !== exceptId &&
				other.name.toLowerCase() === trimmed.toLowerCase()
			) {
				throw new TrpcFixtureError(
					"CONFLICT",
					"A smart album with that name already exists",
				);
			}
		}
		return trimmed;
	};
	/** Trimmed query or null; an album needs a filter or a query (BAD_REQUEST). */
	const checkedSmartAlbumContent = (
		filters: FixtureSmartAlbumFilters,
		query: string | null | undefined,
	) => {
		const trimmed = query?.trim() || null;
		if (Object.keys(filters).length === 0 && trimmed === null) {
			throw new TrpcFixtureError(
				"BAD_REQUEST",
				"A smart album needs at least one filter or a query",
			);
		}
		return trimmed;
	};
	/** Trimmed name; NAME_TAKEN (case-insensitive) maps to CONFLICT like the API. */
	const checkedName = (name: string, exceptId?: number) => {
		const trimmed = name.trim();
		if (trimmed.length < 1 || trimmed.length > 100) {
			throw new TrpcFixtureError("BAD_REQUEST", "Invalid collection name");
		}
		for (const other of collections.values()) {
			if (
				other.id !== exceptId &&
				other.name.toLowerCase() === trimmed.toLowerCase()
			) {
				throw new TrpcFixtureError(
					"CONFLICT",
					"A collection with that name already exists",
				);
			}
		}
		return trimmed;
	};
	const addPhotos = (collection: FixtureCollection, photoIds: number[]) => {
		let added = 0;
		for (const photoId of photoIds) {
			if (
				library.some((p) => p.id === photoId) &&
				!collection.photoIds.includes(photoId)
			) {
				collection.photoIds.push(photoId);
				added++;
			}
		}
		collection.updatedAt = now();
		return added;
	};
	/** Applies `collectionId` like the API's `photos.id IN (members)` condition. */
	const scopeToCollection = ({ collectionId }: CollectionScope) => {
		if (collectionId === undefined) return library;
		const members = collections.get(collectionId)?.photoIds ?? [];
		return library.filter((p) => members.includes(p.id));
	};
	/**
	 * Library photos with these IDs plus their RAW+standard partners, in
	 * ascending ID order (the library's order), like the API's
	 * `updatePhotoCuration` behind setPhotoCuration, junk reject and duplicate keep.
	 */
	const withPartners = (photoIds: readonly number[]) =>
		library.filter(
			(p) =>
				photoIds.includes(p.id) ||
				(p.pairedPhotoId !== null && photoIds.includes(p.pairedPhotoId)),
		);
	/** Suggested keeper order like the API (no sharpness in the fixtures). */
	const keeperOrder = (a: FixturePhoto, b: FixturePhoto) =>
		b.rating - a.rating ||
		Number(b.flag === "pick") - Number(a.flag === "pick") ||
		Number(b.isRaw) - Number(a.isRaw) ||
		b.width * b.height - a.width * a.height ||
		b.size - a.size ||
		a.id - b.id;
	/**
	 * Current groups like the API: rejected members drop out, groups need 2+
	 * (bursts 3+) members, keys encode membership, dismissed keys are hidden.
	 * Larger groups first, then newest; keeper first, then id ascending.
	 */
	const duplicateGroups = () =>
		FIXTURE_DUPLICATE_GROUPS.flatMap(({ kind, photoIds, maxDistance }) => {
			// A RAW whose partner is also a candidate is one photo with it.
			const members = library.filter(
				(p) =>
					photoIds.includes(p.id) &&
					p.flag !== "reject" &&
					!(
						p.isRaw &&
						p.pairedPhotoId !== null &&
						photoIds.includes(p.pairedPhotoId)
					),
			);
			if (members.length < (kind === "burst" ? 3 : 2)) return [];
			const key = `${kind}:${members.map((p) => p.id).join(",")}`;
			if (duplicateDismissals.has(key)) return [];
			const keeper = [...members].sort(keeperOrder)[0];
			return [
				{
					key,
					kind,
					photos: [keeper, ...members.filter((p) => p !== keeper)],
					suggestedKeeperId: keeper.id,
					maxDistance,
				},
			];
		}).sort(
			(a, b) =>
				b.photos.length - a.photos.length ||
				Math.max(...b.photos.map((p) => p.id)) -
					Math.max(...a.photos.map((p) => p.id)),
		);
	return {
		folders: () => FIXTURE_FOLDERS,
		photos: (input) => {
			const { collectionId, ...filters } = (input ??
				{}) as FixturePhotoFilters & CollectionScope;
			const photos = filterFixturePhotos(
				scopeToCollection({ collectionId }),
				filters,
			);
			return {
				photos,
				total: photos.length,
				// RAW rows plus standard rows stacking a RAW partner.
				rawCount: photos.filter((p) => p.isRaw || p.pairedPhotoId !== null)
					.length,
			};
		},
		// Like the API: the same filters and stacking, then valid locations only.
		photoLocations: (input) => {
			const { collectionId, ...filters } = (input ??
				{}) as FixturePhotoFilters & CollectionScope;
			const points = filterFixturePhotos(
				scopeToCollection({ collectionId }),
				filters,
			)
				.flatMap((p) => {
					const location = fixtureLocation(p);
					return location ? [{ id: p.id, ...location }] : [];
				})
				.sort((a, b) => a.id - b.id);
			return { points, total: points.length };
		},
		searchPhotos: (input) => {
			const {
				query = "",
				collectionId,
				...filters
			} = (input ?? {}) as FixturePhotoFilters &
				CollectionScope & {
					query?: string;
				};
			const photos = searchPhotosByQuery(
				query,
				filterFixturePhotos(scopeToCollection({ collectionId }), filters),
			);
			return { photos, total: photos.length, query };
		},
		photo: (input) => {
			const { id } = input as { id: number };
			const photo = library.find((p) => p.id === id);
			if (!photo) throw new Error("Photo not found");
			return photo;
		},
		similarPhotos: (input) => {
			const { photoId, collectionId, tag, country, place } = (input ??
				{}) as CollectionScope & {
				photoId?: number;
				tag?: string;
				country?: string;
				place?: number;
			};
			const source = library.find((p) => p.id === photoId);
			if (!source) {
				throw new Error(`Photo ${photoId} not found`);
			}
			// Never the source itself or its own pair partner.
			const photos = filterFixturePhotos(scopeToCollection({ collectionId }), {
				tag,
				country,
				place,
			})
				.filter((p) => p.id !== photoId && p.id !== source.pairedPhotoId)
				.reverse();
			return {
				photos,
				total: photos.length,
				sourcePhotoId: photoId,
				indexed: true,
			};
		},
		setPhotoCuration: (input) => {
			const { photoIds, rating, flag } = input as CurationInput;
			const updated = withPartners(photoIds).map((p) => {
				if (rating !== undefined) p.rating = rating;
				if (flag !== undefined) p.flag = flag;
				return { id: p.id, rating: p.rating, flag: p.flag };
			});
			return { updated };
		},
		junkReview: (input) => {
			const {
				reason,
				limit = 200,
				cursor,
			} = (input ?? {}) as {
				reason?: FixtureJunkReason;
				limit?: number;
				cursor?: number;
			};
			if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
				throw new TrpcFixtureError("BAD_REQUEST", "Invalid limit");
			}
			// Newest first (id desc: fixture dates are equal), with the API's
			// exclusions: dismissed, picked/rejected, rated, or a paired RAW.
			const candidates = library
				.filter(
					(p) =>
						FIXTURE_JUNK_REASONS[p.id] !== undefined &&
						!junkDismissed.has(p.id) &&
						p.flag === null &&
						p.rating < 1 &&
						!(p.isRaw && p.pairedPhotoId !== null),
				)
				.sort((a, b) => b.id - a.id)
				.map((p) => ({ ...p, junkReasons: FIXTURE_JUNK_REASONS[p.id] }));
			const matching = candidates.filter(
				(p) =>
					(reason === undefined || p.junkReasons.includes(reason)) &&
					(cursor === undefined || p.id < cursor),
			);
			const photos = matching.slice(0, limit);
			const countOf = (r: FixtureJunkReason) =>
				candidates.filter((p) => p.junkReasons.includes(r)).length;
			return {
				photos,
				nextCursor:
					matching.length > limit ? (photos.at(-1)?.id ?? null) : null,
				counts: {
					all: candidates.length,
					screenshot: countOf("screenshot"),
					document: countOf("document"),
					blurry: countOf("blurry"),
					dark: countOf("dark"),
				},
			};
		},
		resolveJunk: (input) => {
			const { photoIds, action } = input as {
				photoIds: number[];
				action: "reject" | "keep";
			};
			if (photoIds.length < 1 || photoIds.length > 500) {
				throw new TrpcFixtureError("BAD_REQUEST", "Invalid photoIds");
			}
			if (action === "reject") {
				// Through the curation update, so pair partners follow.
				const updated = withPartners(photoIds).map((p) => {
					p.flag = "reject";
					return p.id;
				});
				return { updated };
			}
			const updated = library
				.filter((p) => photoIds.includes(p.id))
				.map((p) => {
					junkDismissed.add(p.id);
					return p.id;
				});
			return { updated };
		},
		duplicateGroups: (input) => {
			const {
				kind,
				limit = 50,
				cursor,
			} = (input ?? {}) as {
				kind?: FixtureDuplicateKind;
				limit?: number;
				cursor?: string;
			};
			if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
				throw new TrpcFixtureError("BAD_REQUEST", "Invalid limit");
			}
			const all = duplicateGroups();
			const matching = all.filter((g) => kind === undefined || g.kind === kind);
			const offset = cursor === undefined ? 0 : Number(cursor);
			const end = offset + limit;
			return {
				groups: matching.slice(offset, end),
				counts: {
					duplicate: all.filter((g) => g.kind === "duplicate").length,
					burst: all.filter((g) => g.kind === "burst").length,
				},
				nextCursor: matching.length > end ? String(end) : null,
			};
		},
		resolveDuplicateGroup: (input) => {
			const { key, action, keepIds } = input as {
				key: string;
				action: "keep" | "dismiss";
				keepIds?: number[];
			};
			const group = duplicateGroups().find((g) => g.key === key);
			if (!group) {
				throw new TrpcFixtureError("CONFLICT", "GROUP_CHANGED");
			}
			if (action === "dismiss") {
				duplicateDismissals.add(key);
				return { dismissed: key };
			}
			const memberIds = group.photos.map((p) => p.id);
			if (
				!keepIds ||
				keepIds.length === 0 ||
				keepIds.some((id) => !memberIds.includes(id))
			) {
				throw new TrpcFixtureError("BAD_REQUEST", "Invalid keepIds");
			}
			const rejected = withPartners(
				group.photos.filter((p) => !keepIds.includes(p.id)).map((p) => p.id),
			).map((p) => {
				p.flag = "reject";
				return p.id;
			});
			if (keepIds.length > 1) {
				const kept = [...keepIds].sort((a, b) => a - b).join(",");
				duplicateDismissals.add(`${group.kind}:${kept}`);
			}
			return { rejected };
		},
		collections: () => ({
			collections: [...collections.values()]
				.sort((a, b) =>
					a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
				)
				.map(collectionDto),
		}),
		smartAlbums: () => ({
			albums: [...smartAlbums.values()]
				.sort((a, b) =>
					a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
				)
				.map(smartAlbumDto),
		}),
		createSmartAlbum: (input) => {
			const { name, filters, query } = input as {
				name: string;
				filters: FixtureSmartAlbumFilters;
				query?: string | null;
			};
			const createdAt = now();
			const album: FixtureSmartAlbum = {
				id: nextSmartAlbumId,
				name: checkedSmartAlbumName(name),
				filters,
				query: checkedSmartAlbumContent(filters, query),
				createdAt,
				updatedAt: createdAt,
			};
			nextSmartAlbumId++;
			smartAlbums.set(album.id, album);
			return smartAlbumDto(album);
		},
		updateSmartAlbum: (input) => {
			const { id, name, filters, query } = input as {
				id: number;
				name?: string;
				filters?: FixtureSmartAlbumFilters;
				query?: string | null;
			};
			const album = findSmartAlbum(id);
			const nextName =
				name === undefined ? album.name : checkedSmartAlbumName(name, id);
			const nextFilters = filters ?? album.filters;
			const nextQuery = checkedSmartAlbumContent(
				nextFilters,
				query === undefined ? album.query : query,
			);
			Object.assign(album, {
				name: nextName,
				filters: nextFilters,
				query: nextQuery,
				updatedAt: now(),
			});
			return smartAlbumDto(album);
		},
		deleteSmartAlbum: (input) => {
			const { id } = input as { id: number };
			findSmartAlbum(id);
			smartAlbums.delete(id);
			return { id };
		},
		photoTags: (input) => {
			const { photoId } = input as { photoId: number };
			if (!library.some((p) => p.id === photoId)) {
				throw new TrpcFixtureError("NOT_FOUND", "Photo not found");
			}
			return { tags: FIXTURE_PHOTO_TAGS[photoId] ?? [] };
		},
		photoPlace: (input) => {
			const { photoId } = input as { photoId: number };
			if (!library.some((p) => p.id === photoId)) {
				throw new TrpcFixtureError("NOT_FOUND", "Photo not found");
			}
			return { place: FIXTURE_PHOTO_PLACES[photoId] ?? null };
		},
		collectionsForPhoto: (input) => {
			const { photoId } = input as { photoId: number };
			if (!library.some((p) => p.id === photoId)) {
				throw new TrpcFixtureError("NOT_FOUND", "Photo not found");
			}
			return {
				collectionIds: [...collections.values()]
					.filter((c) => c.photoIds.includes(photoId))
					.map((c) => c.id),
			};
		},
		createCollection: (input) => {
			const { name, photoIds = [] } = input as {
				name: string;
				photoIds?: number[];
			};
			const createdAt = now();
			const collection: FixtureCollection = {
				id: nextCollectionId++,
				name: checkedName(name),
				createdAt,
				updatedAt: createdAt,
				photoIds: [],
			};
			collections.set(collection.id, collection);
			if (photoIds.length > 0) addPhotos(collection, photoIds);
			return collectionDto(collection);
		},
		renameCollection: (input) => {
			const { id, name } = input as { id: number; name: string };
			const collection = findCollection(id);
			collection.name = checkedName(name, id);
			collection.updatedAt = now();
			return collectionDto(collection);
		},
		deleteCollection: (input) => {
			const { id } = input as { id: number };
			findCollection(id);
			collections.delete(id);
			return { id };
		},
		addToCollection: (input) => {
			const { collectionId, photoIds } = input as {
				collectionId: number;
				photoIds: number[];
			};
			const collection = findCollection(collectionId);
			const added = addPhotos(collection, photoIds);
			return { added, photoCount: collection.photoIds.length };
		},
		removeFromCollection: (input) => {
			const { collectionId, photoIds } = input as {
				collectionId: number;
				photoIds: number[];
			};
			const collection = findCollection(collectionId);
			const before = collection.photoIds.length;
			collection.photoIds = collection.photoIds.filter(
				(id) => !photoIds.includes(id),
			);
			collection.updatedAt = now();
			return {
				removed: before - collection.photoIds.length,
				photoCount: collection.photoIds.length,
			};
		},
		filterOptions: (input) => {
			// Folder-scoped like the API's tag and place counts.
			const scoped = filterFixturePhotos(library, {
				folder: (input as { folder?: string } | undefined)?.folder,
			});
			// Photo rows, not stacked pairs, like the API's place counts.
			const scopedRows = library.filter((p) =>
				scoped.some((s) => s.id === p.id || s.id === p.pairedPhotoId),
			);
			return {
				cameras: ["Sony A7III", "Canon EOS R5", "Fujifilm X-T5"],
				lenses: [
					"FE 24-70mm f/2.8 GM",
					"FE 85mm f/1.4 GM",
					"RF 15-35mm f/2.8L IS USM",
				],
				isos: [100, 200, 400, 800, 3200],
				dates: ["2024-06", "2024-07", "2024-08"],
				tags: fixtureTagCounts(scoped),
				...fixturePlaceOptions(scopedRows),
			};
		},
		scan: () => ({ success: true, jobId: FIXTURE_JOB_ID }),
		scanStatus: (input) => ({
			id:
				typeof input === "object" && input !== null && "jobId" in input
					? input.jobId
					: FIXTURE_JOB_ID,
			status: "queued",
			phase: "queued",
			current: 0,
			total: 0,
			error: null,
			updatedAt: new Date("2024-01-01T00:00:00Z"),
		}),
		realtimeToken: () => ({
			token: {
				channel: `job:${FIXTURE_JOB_ID}`,
				topics: ["progress"],
				key: "test-token-xyz",
			},
		}),
	};
}

/** The web's default `MAP_STYLE_URL` (the dev server sets no override). */
export const FIXTURE_MAP_STYLE_URL =
	"https://tiles.openfreemap.org/styles/liberty";

/** Minimal offline MapLibre style: one background layer, no sources. */
const FIXTURE_MAP_STYLE = {
	version: 8,
	sources: {},
	layers: [
		{
			id: "background",
			type: "background",
			paint: { "background-color": "#dfe7ec" },
		},
	],
};

/** Inputs received by each mocked procedure, in request order. */
export type TrpcCallLog = Record<string, unknown[]>;

export async function installTrpcHandlers(
	page: Page,
	overrides: HandlerOverrides = {},
): Promise<TrpcCallLog> {
	const defaults = createDefaultHandlers();
	const handlers = { ...defaults, ...overrides };
	const calls: TrpcCallLog = {};

	await page.route(/\/trpc\//, async (route: Route) => {
		const req = route.request();
		const url = new URL(req.url());
		const batch = parseTrpcBatchRequest(url, req.method(), req.postData());
		const results = await Promise.all(
			batch.map(async ({ path, input }) => {
				const handler = handlers[path];
				if (!handler) {
					return {
						error: {
							json: { message: `No handler for ${path}`, code: -32000 },
						},
					};
				}
				(calls[path] ??= []).push(input);
				try {
					// superjson response envelope preserves Date/undefined/etc via meta
					const value = await handler(input, defaults);
					const serialized = superjson.serialize(value);
					return {
						result: {
							data: { json: serialized.json, meta: serialized.meta },
						},
					};
				} catch (error) {
					// A TrpcFixtureError carries its tRPC code; any other throw (e.g. an
					// override told to fail) becomes INTERNAL_SERVER_ERROR.
					const code =
						error instanceof TrpcFixtureError
							? error.code
							: "INTERNAL_SERVER_ERROR";
					return {
						error: {
							json: {
								message: error instanceof Error ? error.message : String(error),
								code: TRPC_ERROR_CODES[code].code,
								data: {
									code,
									httpStatus: TRPC_ERROR_CODES[code].httpStatus,
									path,
								},
							},
						},
					};
				}
			}),
		);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify(results),
		});
	});

	await page.route(/\/api\/photos\/\d+\/thumbnail\//, (route) =>
		route.fulfill({
			status: 200,
			contentType: "image/webp",
			body: TINY_WEBP_BYTES,
		}),
	);
	await page.route(/\/api\/photos\/\d+\/file/, (route) =>
		route.fulfill({
			status: 200,
			contentType: "image/jpeg",
			body: TINY_JPEG_BYTES,
		}),
	);

	// Block Inngest Realtime SSE
	await page.route(/inngest\.com|\/api\/inngest/, (route) =>
		route.fulfill({ status: 204, body: "" }),
	);

	// Map: the default style URL gets a background-only style, so no tiles,
	// sprites, or glyphs are requested; anything else from the tile host fails.
	await page.route(/tiles\.openfreemap\.org/, (route) =>
		route.request().url() === FIXTURE_MAP_STYLE_URL
			? route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(FIXTURE_MAP_STYLE),
				})
			: route.abort(),
	);

	return calls;
}
