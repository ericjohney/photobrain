import { z } from "zod";
import { router, publicProcedure } from "./trpc";
import { photos as photosTable, photoExif as photoExifTable } from "@/db/schema";
import { searchPhotosByText } from "@/services/vector-search";
import { scanDirectory } from "@/scanner";
import { config } from "@/config";
import { eq } from "drizzle-orm";

export const appRouter = router({
	// Get all photos with EXIF data
	photos: publicProcedure.query(async ({ ctx }) => {
		const photosList = await ctx.db.query.photos.findMany({
			with: {
				exif: true,
			},
		});
		return {
			photos: photosList,
			total: photosList.length,
		};
	}),

	// Get single photo by ID with EXIF data
	photo: publicProcedure
		.input(z.object({ id: z.number() }))
		.query(async ({ ctx, input }) => {
			const photo = await ctx.db.query.photos.findFirst({
				where: (photos, { eq }) => eq(photos.id, input.id),
				with: {
					exif: true,
				},
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

		for (const photoWithExif of result.photos) {
			try {
				// Check if photo already exists
				const existing = await ctx.db.query.photos.findFirst({
					where: eq(photosTable.path, photoWithExif.photo.path),
				});

				if (existing) {
					skipped++;
				} else {
					// Insert new photo
					const insertResult = await ctx.db
						.insert(photosTable)
						.values({
							path: photoWithExif.photo.path,
							name: photoWithExif.photo.name,
							size: photoWithExif.photo.size,
							createdAt: photoWithExif.photo.createdAt,
							modifiedAt: photoWithExif.photo.modifiedAt,
							mimeType: photoWithExif.photo.mimeType,
							width: photoWithExif.photo.width,
							height: photoWithExif.photo.height,
							phash: photoWithExif.photo.phash,
							clipEmbedding: photoWithExif.photo.clipEmbedding,
						})
						.returning({ id: photosTable.id });

					const photoId = insertResult[0].id;

					// Insert EXIF data if available
					if (photoWithExif.exif) {
						await ctx.db.insert(photoExifTable).values({
							photoId,
							...photoWithExif.exif,
						});
					}

					inserted++;
				}
			} catch (error) {
				console.error(`Error processing photo ${photoWithExif.photo.path}:`, error);
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
