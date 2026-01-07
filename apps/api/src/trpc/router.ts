import { stat } from "node:fs/promises";
import { join } from "node:path";
import { extractPhotoMetadata } from "@photobrain/image-processing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { config } from "@/config";
import {
	photoExif as photoExifTable,
	photos as photosTable,
} from "@/db/schema";
import { scanDirectory } from "@/scanner";
import {
	cleanupTempConversion,
	convertRawToTemp,
} from "@/services/raw-converter";
import { searchPhotosByText } from "@/services/vector-search";
import { publicProcedure, router } from "./trpc";

export const appRouter = router({
	// Get all photos with EXIF data
	photos: publicProcedure
		.input(
			z
				.object({
					filterRaw: z.enum(["all", "raw", "standard"]).default("all"),
				})
				.optional(),
		)
		.query(async ({ ctx, input }) => {
			const filter = input?.filterRaw ?? "all";

			const photosList = await ctx.db.query.photos.findMany({
				where:
					filter === "raw"
						? eq(photosTable.isRaw, true)
						: filter === "standard"
							? eq(photosTable.isRaw, false)
							: undefined,
				with: {
					exif: true,
				},
			});

			const rawCount = photosList.filter((p) => p.isRaw).length;

			return {
				photos: photosList,
				total: photosList.length,
				rawCount,
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
			}),
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
			thumbnailsDirectory: config.THUMBNAILS_DIRECTORY,
			recursive: true,
		});

		// Insert or update photos in database
		let inserted = 0;
		let skipped = 0;
		let rawCount = 0;

		for (const photoWithExif of result.photos) {
			try {
				// Check if photo already exists
				const existing = await ctx.db.query.photos.findFirst({
					where: eq(photosTable.path, photoWithExif.photo.path),
				});

				if (existing) {
					skipped++;
				} else {
					// Insert new photo (including RAW fields)
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
							// RAW fields
							isRaw: photoWithExif.photo.isRaw ?? false,
							rawFormat: photoWithExif.photo.rawFormat ?? null,
							rawStatus: photoWithExif.photo.rawStatus ?? null,
							rawError: photoWithExif.photo.rawError ?? null,
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

					if (photoWithExif.photo.isRaw) {
						rawCount++;
					}

					inserted++;
				}
			} catch (error) {
				console.error(
					`Error processing photo ${photoWithExif.photo.path}:`,
					error,
				);
			}
		}

		const totalTime = Date.now() - startTime;

		return {
			success: true,
			scanned: result.photos.length,
			inserted,
			skipped,
			rawCount,
			duration: totalTime / 1000, // Convert to seconds
			scanDuration: result.duration,
			directory: config.PHOTO_DIRECTORY,
		};
	}),

	// Reprocess a failed RAW file
	reprocessRaw: publicProcedure
		.input(z.object({ id: z.number() }))
		.mutation(async ({ ctx, input }) => {
			// Get the photo
			const photo = await ctx.db.query.photos.findFirst({
				where: eq(photosTable.id, input.id),
			});

			if (!photo) {
				throw new Error("Photo not found");
			}

			if (!photo.isRaw) {
				throw new Error("Photo is not a RAW file");
			}

			// Get absolute path to RAW file
			const absolutePath = join(config.PHOTO_DIRECTORY, photo.path);

			// Check if file exists
			try {
				await stat(absolutePath);
			} catch {
				throw new Error("RAW file not found on disk");
			}

			// Convert RAW to temp JPEG
			const conversionResult = await convertRawToTemp(absolutePath);

			if (!conversionResult.success || !conversionResult.outputPath) {
				// Update database with failure
				await ctx.db
					.update(photosTable)
					.set({
						rawStatus: "failed",
						rawError: conversionResult.error ?? "Unknown error",
					})
					.where(eq(photosTable.id, input.id));

				return {
					success: false,
					error: conversionResult.error,
				};
			}

			try {
				// Process the converted JPEG through Rust pipeline
				const rustMetadata = extractPhotoMetadata(
					conversionResult.outputPath,
					config.PHOTO_DIRECTORY,
					config.THUMBNAILS_DIRECTORY,
				);

				// Convert clipEmbedding to Float32Array
				const clipEmbedding = rustMetadata.clipEmbedding
					? new Float32Array(rustMetadata.clipEmbedding)
					: undefined;

				// Update database with new metadata
				await ctx.db
					.update(photosTable)
					.set({
						width: rustMetadata.width,
						height: rustMetadata.height,
						phash: rustMetadata.phash,
						clipEmbedding,
						rawStatus: "converted",
						rawError: null,
					})
					.where(eq(photosTable.id, input.id));

				return {
					success: true,
					duration: conversionResult.duration,
				};
			} finally {
				// Clean up temp file
				await cleanupTempConversion(conversionResult.outputPath);
			}
		}),
});

// Export type for use in clients
export type AppRouter = typeof appRouter;
