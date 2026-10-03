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
	getPhoto,
	listFilterOptions,
	listFolders,
	listPhotos,
} from "../services/photo-catalog";
import {
	MAX_CURATION_IDS,
	PHOTO_FLAGS,
	updatePhotoCuration,
} from "../services/photo-curation";
import { searchPhotoCatalog } from "../services/photo-search";
import { getPhotoTags } from "../services/photo-tagging";
import { getScan, startScan } from "../services/scan-jobs";
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

// Filters shared by photos, searchPhotos, and similarPhotos.
const sharedFilterShape = {
	minRating: z.number().int().min(1).max(5).optional(),
	flag: z.enum(["pick", "reject", "unflagged"]).optional(),
	collectionId: z.number().int().positive().optional(),
	tag: z.string().max(MAX_TAG_SLUG_LENGTH).regex(TAG_SLUG_PATTERN).optional(),
};

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
		.input(
			z
				.object({
					filterRaw: z.enum(["all", "raw", "standard"]).default("all"),
					folder: z.string().optional(),
					camera: z.string().optional(),
					lens: z.string().optional(),
					iso: z.number().optional(),
					dateMonth: z.string().optional(),
					...sharedFilterShape,
				})
				.optional(),
		)
		.query(({ ctx, input }) => listPhotos(ctx.db, input ?? {})),

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
