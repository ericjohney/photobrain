import { z } from "zod";
import { router, publicProcedure } from "./trpc";
import { photos as photosTable } from "@/db/schema";
import { searchPhotosByText } from "@/services/vector-search";
import { scanDirectory } from "@/scanner";
import { config } from "@/config";
import { eq } from "drizzle-orm";

export const appRouter = router({
	// Get all photos
	photos: publicProcedure.query(async ({ ctx }) => {
		const photosList = await ctx.db.select().from(photosTable).all();
		return {
			photos: photosList,
			total: photosList.length,
		};
	}),

	// Get single photo by ID
	photo: publicProcedure
		.input(z.object({ id: z.number() }))
		.query(async ({ ctx, input }) => {
			const photo = await ctx.db.query.photos.findFirst({
				where: (photos, { eq }) => eq(photos.id, input.id),
			});

			if (!photo) {
				throw new Error("Photo not found");
			}

			return photo;
		}),

	// Search photos using semantic search
	searchPhotos: publicProcedure
		.input(
			z.object({
				query: z.string().min(1),
				limit: z.number().min(1).max(100).default(20),
			})
		)
		.query(async ({ input }) => {
			const photos = await searchPhotosByText(input.query, input.limit);
			return {
				photos,
				total: photos.length,
				query: input.query,
			};
		}),

	// Scan directory for photos
	scan: publicProcedure.mutation(async ({ ctx }) => {
		const startTime = Date.now();

		// Scan the directory
		const result = await scanDirectory({
			directory: config.PHOTO_DIRECTORY,
			recursive: true,
		});

		// Insert or update photos in database
		let inserted = 0;
		let skipped = 0;

		for (const photo of result.photos) {
			try {
				// Check if photo already exists
				const existing = await ctx.db.query.photos.findFirst({
					where: eq(photosTable.path, photo.path),
				});

				if (existing) {
					skipped++;
				} else {
					// Insert new photo
					await ctx.db.insert(photosTable).values({
						path: photo.path,
						name: photo.name,
						size: photo.size,
						createdAt: photo.createdAt,
						modifiedAt: photo.modifiedAt,
						mimeType: photo.mimeType,
						width: photo.width,
						height: photo.height,
						phash: photo.phash,
						clipEmbedding: photo.clipEmbedding,
					});
					inserted++;
				}
			} catch (error) {
				console.error(`Error processing photo ${photo.path}:`, error);
			}
		}

		const totalTime = Date.now() - startTime;

		return {
			success: true,
			scanned: result.photos.length,
			inserted,
			skipped,
			duration: totalTime / 1000, // Convert to seconds
			scanDuration: result.duration,
			directory: config.PHOTO_DIRECTORY,
		};
	}),
});

// Export type for use in clients
export type AppRouter = typeof appRouter;
