import { getSubscriptionToken } from "@inngest/realtime";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { config } from "../config";
import { inngest } from "../inngest/client";
import {
	addPhotosToCollection,
	CollectionError,
	collectionsForPhoto,
	createCollection,
	deleteCollection,
	listCollections,
	MAX_COLLECTION_NAME_LENGTH,
	MAX_COLLECTION_PHOTO_IDS,
	removePhotosFromCollection,
	renameCollection,
} from "../services/collections";
import {
	DUPLICATE_ACTIONS,
	DUPLICATE_CURSOR_PATTERN,
	DUPLICATE_GROUPS_DEFAULT_LIMIT,
	DUPLICATE_GROUPS_MAX_LIMIT,
	DUPLICATE_KINDS,
	DuplicateGroupError,
	duplicateGroups,
	MAX_DUPLICATE_KEY_LENGTH,
	resolveDuplicateGroup,
} from "../services/duplicates";
import {
	JUNK_ACTIONS,
	JUNK_REASONS,
	JUNK_REVIEW_DEFAULT_LIMIT,
	JUNK_REVIEW_MAX_LIMIT,
	junkReview,
	MAX_JUNK_RESOLVE_IDS,
	resolveJunk,
} from "../services/junk-review";
import {
	getPhoto,
	isValidPhotoBounds,
	listFilterOptions,
	listFolders,
	listPhotoLocations,
	listPhotos,
} from "../services/photo-catalog";
import {
	MAX_CURATION_IDS,
	PHOTO_FLAGS,
	updatePhotoCuration,
} from "../services/photo-curation";
import { getPhotoPlace } from "../services/photo-places";
import { searchPhotoCatalog } from "../services/photo-search";
import { getPhotoTags } from "../services/photo-tagging";
import { COUNTRY_CODE_PATTERN } from "../services/place-lookup";
import { getScan, startScan } from "../services/scan-jobs";
import {
	createSmartAlbum,
	deleteSmartAlbum,
	listSmartAlbums,
	MAX_SMART_ALBUM_NAME_LENGTH,
	MAX_SMART_ALBUM_QUERY_LENGTH,
	SMART_ALBUM_DATE_MONTH_PATTERN,
	SmartAlbumError,
	updateSmartAlbum,
} from "../services/smart-albums";
import {
	MAX_TAG_SLUG_LENGTH,
	TAG_SLUG_PATTERN,
} from "../services/tag-vocabulary";
import {
	findSimilarToPhoto,
	searchPhotosByText,
} from "../services/vector-search";
import { publicProcedure, router } from "./trpc";

export type { FolderNode } from "../services/photo-catalog";

// Filters shared by photos, photoLocations, searchPhotos, and similarPhotos.
const sharedFilterShape = {
	minRating: z.number().int().min(1).max(5).optional(),
	flag: z.enum(["pick", "reject", "unflagged"]).optional(),
	collectionId: z.number().int().positive().optional(),
	tag: z.string().max(MAX_TAG_SLUG_LENGTH).regex(TAG_SLUG_PATTERN).optional(),
	country: z.string().regex(COUNTRY_CODE_PATTERN).optional(),
	place: z.number().int().positive().optional(),
	bounds: z
		.object({
			north: z.number(),
			south: z.number(),
			east: z.number(),
			west: z.number(),
		})
		.refine(isValidPhotoBounds, {
			message:
				"Bounds must be finite, latitudes in [-90, 90], longitudes in [-180, 180], south <= north",
		})
		.optional(),
};

// Input of photos and photoLocations.
const photoFiltersInput = z
	.object({
		filterRaw: z.enum(["all", "raw", "standard"]).default("all"),
		folder: z.string().optional(),
		camera: z.string().optional(),
		lens: z.string().optional(),
		iso: z.number().optional(),
		dateMonth: z.string().optional(),
		...sharedFilterShape,
	})
	.optional();

const collectionIdSchema = z.number().int().positive();
const collectionNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_COLLECTION_NAME_LENGTH);
const collectionPhotoIdsSchema = z
	.array(z.number().int().positive())
	.min(1)
	.max(MAX_COLLECTION_PHOTO_IDS);

/** Maps collection domain errors to tRPC codes; other errors propagate unchanged. */
function collectionMutation<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof CollectionError) {
			throw new TRPCError({
				code: error.code === "NAME_TAKEN" ? "CONFLICT" : "NOT_FOUND",
				message: error.message,
				cause: error,
			});
		}
		throw error;
	}
}

const smartAlbumIdSchema = z.number().int().positive();
const smartAlbumNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_SMART_ALBUM_NAME_LENGTH);
const smartAlbumQuerySchema = z
	.string()
	.trim()
	.min(1)
	.max(MAX_SMART_ALBUM_QUERY_LENGTH)
	.nullable();
// Photo filters minus collectionId and bounds (strict, so both are rejected).
// Empty strings and filterRaw "all" mean "no filter"; dateMonth accepts
// `YYYY:MM` (what filterOptions emits) or `YYYY-MM`.
const smartAlbumFiltersSchema = z
	.object({
		filterRaw: z.enum(["all", "raw", "standard"]).optional(),
		folder: z.string().optional(),
		camera: z.string().optional(),
		lens: z.string().optional(),
		iso: z.number().int().positive().optional(),
		dateMonth: z
			.union([z.literal(""), z.string().regex(SMART_ALBUM_DATE_MONTH_PATTERN)])
			.optional(),
		minRating: sharedFilterShape.minRating,
		flag: sharedFilterShape.flag,
		tag: z
			.union([
				z.literal(""),
				z.string().max(MAX_TAG_SLUG_LENGTH).regex(TAG_SLUG_PATTERN),
			])
			.optional(),
		country: z
			.union([z.literal(""), z.string().regex(COUNTRY_CODE_PATTERN)])
			.optional(),
		place: sharedFilterShape.place,
	})
	.strict();

/** Maps smart album domain errors to tRPC codes; other errors propagate unchanged. */
function smartAlbumMutation<T>(run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof SmartAlbumError) {
			throw new TRPCError({
				code:
					error.code === "NAME_TAKEN"
						? "CONFLICT"
						: error.code === "NOT_FOUND"
							? "NOT_FOUND"
							: "BAD_REQUEST",
				message: error.message,
				cause: error,
			});
		}
		throw error;
	}
}

export const appRouter = router({
	folders: publicProcedure.query(({ ctx }) => listFolders(ctx.db)),

	filterOptions: publicProcedure
		.input(
			z
				.object({
					folder: z.string().optional(),
				})
				.optional(),
		)
		.query(({ ctx, input }) => listFilterOptions(ctx.db, input ?? {})),

	photos: publicProcedure
		.input(photoFiltersInput)
		.query(({ ctx, input }) => listPhotos(ctx.db, input ?? {})),

	photoLocations: publicProcedure
		.input(photoFiltersInput)
		.query(({ ctx, input }) => listPhotoLocations(ctx.db, input ?? {})),

	photo: publicProcedure
		.input(z.object({ id: z.number() }))
		.query(async ({ ctx, input }) => {
			const photo = await getPhoto(ctx.db, input.id);
			if (!photo) throw new Error("Photo not found");
			return photo;
		}),

	photoTags: publicProcedure
		.input(z.object({ photoId: z.number().int().positive() }))
		.query(({ ctx, input }) => {
			const result = getPhotoTags(ctx.db, input.photoId);
			if (!result) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Photo not found" });
			}
			return result;
		}),

	photoPlace: publicProcedure
		.input(z.object({ photoId: z.number().int().positive() }))
		.query(({ ctx, input }) => {
			const result = getPhotoPlace(ctx.db, input.photoId);
			if (!result) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Photo not found" });
			}
			return result;
		}),

	searchPhotos: publicProcedure
		.input(
			z.object({
				query: z.string().min(1),
				limit: z.number().min(1).max(100).default(20),
				filterRaw: z.enum(["all", "raw", "standard"]).default("all"),
				folder: z.string().optional(),
				camera: z.string().optional(),
				lens: z.string().optional(),
				iso: z.number().int().optional(),
				dateMonth: z.string().optional(),
				...sharedFilterShape,
			}),
		)
		.query(({ ctx, input }) =>
			searchPhotoCatalog(
				(query, limit, filters, representation) =>
					searchPhotosByText(ctx.db, query, limit, filters, representation),
				input,
			),
		),

	similarPhotos: publicProcedure
		.input(
			z.object({
				photoId: z.number().int().positive(),
				limit: z.number().int().min(1).max(100).default(30),
				...sharedFilterShape,
			}),
		)
		.query(async ({ ctx, input }) => {
			const { photoId, limit, ...filters } = input;
			const result = await findSimilarToPhoto(ctx.db, photoId, limit, filters);
			if (!result) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Photo not found" });
			}
			return result;
		}),

	setPhotoCuration: publicProcedure
		.input(
			z
				.object({
					photoIds: z
						.array(z.number().int().positive())
						.min(1)
						.max(MAX_CURATION_IDS),
					rating: z.number().int().min(0).max(5).optional(),
					flag: z.enum(PHOTO_FLAGS).nullable().optional(),
				})
				.refine(
					(input) => input.rating !== undefined || input.flag !== undefined,
					{ message: "Provide rating or flag" },
				),
		)
		.mutation(({ ctx, input }) => {
			const { photoIds, ...patch } = input;
			return updatePhotoCuration(ctx.db, photoIds, patch);
		}),

	junkReview: publicProcedure
		.input(
			z
				.object({
					reason: z.enum(JUNK_REASONS).optional(),
					limit: z
						.number()
						.int()
						.min(1)
						.max(JUNK_REVIEW_MAX_LIMIT)
						.default(JUNK_REVIEW_DEFAULT_LIMIT),
					cursor: z.number().int().positive().optional(),
				})
				.optional(),
		)
		.query(({ ctx, input }) => junkReview(ctx.db, input ?? {})),

	resolveJunk: publicProcedure
		.input(
			z.object({
				photoIds: z
					.array(z.number().int().positive())
					.min(1)
					.max(MAX_JUNK_RESOLVE_IDS),
				action: z.enum(JUNK_ACTIONS),
			}),
		)
		.mutation(({ ctx, input }) =>
			resolveJunk(ctx.db, input.photoIds, input.action),
		),

	duplicateGroups: publicProcedure
		.input(
			z
				.object({
					kind: z.enum(DUPLICATE_KINDS).optional(),
					limit: z
						.number()
						.int()
						.min(1)
						.max(DUPLICATE_GROUPS_MAX_LIMIT)
						.default(DUPLICATE_GROUPS_DEFAULT_LIMIT),
					cursor: z.string().regex(DUPLICATE_CURSOR_PATTERN).optional(),
				})
				.optional(),
		)
		.query(({ ctx, input }) => duplicateGroups(ctx.db, input ?? {})),

	resolveDuplicateGroup: publicProcedure
		.input(
			z.object({
				key: z.string().min(1).max(MAX_DUPLICATE_KEY_LENGTH),
				action: z.enum(DUPLICATE_ACTIONS),
				keepIds: z
					.array(z.number().int().positive())
					.max(MAX_CURATION_IDS)
					.optional(),
			}),
		)
		.mutation(({ ctx, input }) => {
			try {
				return resolveDuplicateGroup(ctx.db, input);
			} catch (error) {
				if (error instanceof DuplicateGroupError) {
					throw new TRPCError({
						code: error.code === "GROUP_CHANGED" ? "CONFLICT" : "BAD_REQUEST",
						message: error.message,
						cause: error,
					});
				}
				throw error;
			}
		}),

	collections: publicProcedure.query(({ ctx }) => ({
		collections: listCollections(ctx.db),
	})),

	collectionsForPhoto: publicProcedure
		.input(z.object({ photoId: z.number().int().positive() }))
		.query(({ ctx, input }) => {
			const result = collectionsForPhoto(ctx.db, input.photoId);
			if (!result) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Photo not found" });
			}
			return result;
		}),

	createCollection: publicProcedure
		.input(
			z.object({
				name: collectionNameSchema,
				photoIds: collectionPhotoIdsSchema.optional(),
			}),
		)
		.mutation(({ ctx, input }) =>
			collectionMutation(() =>
				createCollection(ctx.db, input.name, input.photoIds),
			),
		),

	renameCollection: publicProcedure
		.input(z.object({ id: collectionIdSchema, name: collectionNameSchema }))
		.mutation(({ ctx, input }) =>
			collectionMutation(() => renameCollection(ctx.db, input.id, input.name)),
		),

	deleteCollection: publicProcedure
		.input(z.object({ id: collectionIdSchema }))
		.mutation(({ ctx, input }) =>
			collectionMutation(() => {
				deleteCollection(ctx.db, input.id);
				return { id: input.id };
			}),
		),

	addToCollection: publicProcedure
		.input(
			z.object({
				collectionId: collectionIdSchema,
				photoIds: collectionPhotoIdsSchema,
			}),
		)
		.mutation(({ ctx, input }) =>
			collectionMutation(() =>
				addPhotosToCollection(ctx.db, input.collectionId, input.photoIds),
			),
		),

	removeFromCollection: publicProcedure
		.input(
			z.object({
				collectionId: collectionIdSchema,
				photoIds: collectionPhotoIdsSchema,
			}),
		)
		.mutation(({ ctx, input }) =>
			collectionMutation(() =>
				removePhotosFromCollection(ctx.db, input.collectionId, input.photoIds),
			),
		),

	smartAlbums: publicProcedure.query(({ ctx }) => ({
		albums: listSmartAlbums(ctx.db),
	})),

	createSmartAlbum: publicProcedure
		.input(
			z.object({
				name: smartAlbumNameSchema,
				filters: smartAlbumFiltersSchema,
				query: smartAlbumQuerySchema.optional(),
			}),
		)
		.mutation(({ ctx, input }) =>
			smartAlbumMutation(() => createSmartAlbum(ctx.db, input)),
		),

	updateSmartAlbum: publicProcedure
		.input(
			z.object({
				id: smartAlbumIdSchema,
				name: smartAlbumNameSchema.optional(),
				filters: smartAlbumFiltersSchema.optional(),
				query: smartAlbumQuerySchema.optional(),
			}),
		)
		.mutation(({ ctx, input }) => {
			const { id, ...patch } = input;
			return smartAlbumMutation(() => updateSmartAlbum(ctx.db, id, patch));
		}),

	deleteSmartAlbum: publicProcedure
		.input(z.object({ id: smartAlbumIdSchema }))
		.mutation(({ ctx, input }) =>
			smartAlbumMutation(() => {
				deleteSmartAlbum(ctx.db, input.id);
				return { id: input.id };
			}),
		),

	scan: publicProcedure
		.input(z.object({ force: z.boolean().default(false) }).optional())
		.mutation(async ({ ctx, input }) => {
			const result = await startScan(ctx.db, (event) => inngest.send(event), {
				force: input?.force ?? false,
				photoDirectory: config.PHOTO_DIRECTORY,
				thumbnailsDirectory: config.THUMBNAILS_DIRECTORY,
			});
			if (result.success) return result;
			console.error("Failed to start scan job:", result.error);
			return result.jobId
				? { success: false, error: result.error, jobId: result.jobId }
				: { success: false, error: result.error };
		}),

	scanStatus: publicProcedure
		.input(z.object({ jobId: z.string().uuid() }))
		.query(({ ctx, input }) => getScan(ctx.db, input.jobId)),

	realtimeToken: publicProcedure
		.input(z.object({ jobId: z.string() }))
		.query(async ({ input }) => {
			const token = await getSubscriptionToken(inngest, {
				channel: `job:${input.jobId}`,
				topics: ["progress"],
			});
			return { token, baseUrl: config.INNGEST_REALTIME_BASE_URL };
		}),
});

// Export type for use in clients
export type AppRouter = typeof appRouter;
