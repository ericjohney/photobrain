import { getSubscriptionToken } from "@inngest/realtime";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { config } from "../config";
import { inngest } from "../inngest/client";
import {
	getPhoto,
	listFilterOptions,
	listFolders,
	listPhotos,
} from "../services/photo-catalog";
import { searchPhotoCatalog } from "../services/photo-search";
import { getScan, startScan } from "../services/scan-jobs";
import {
	findSimilarToPhoto,
	searchPhotosByText,
} from "../services/vector-search";
import { publicProcedure, router } from "./trpc";

export type { FolderNode } from "../services/photo-catalog";

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
			}),
		)
		.query(async ({ ctx, input }) => {
			const result = await findSimilarToPhoto(
				ctx.db,
				input.photoId,
				input.limit,
			);
			if (!result) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Photo not found" });
			}
			return result;
		}),

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
