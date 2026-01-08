import { stat } from "node:fs/promises";
import { join } from "node:path";
import { processPhoto } from "@photobrain/image-processing";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { config } from "@/config";
import {
	photoExif as photoExifTable,
	photos as photosTable,
} from "@/db/schema";
import { scanDirectory } from "@/scanner";
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

		// Collect all scanned paths
		const scannedPaths = new Set(result.photos.map((p) => p.photo.path));

		// Get all existing photo paths from database
		const existingPhotos = await ctx.db.query.photos.findMany({
			columns: { id: true, path: true },
		});

		// Find photos in DB that are no longer on disk
		const photosToDelete = existingPhotos.filter(
			(p) => !scannedPaths.has(p.path),
		);

		// Delete removed photos (EXIF cascades automatically)
		let deleted = 0;
		if (photosToDelete.length > 0) {
			const idsToDelete = photosToDelete.map((p) => p.id);
			await ctx.db
				.delete(photosTable)
				.where(inArray(photosTable.id, idsToDelete));
			deleted = photosToDelete.length;
			console.log(`🗑️ Removed ${deleted} photos no longer on disk`);
		}

		// Insert or update photos in database
		let inserted = 0;
		let skipped = 0;
		let rawCount = 0;

		// Build set of existing paths for quick lookup
		const existingPaths = new Set(existingPhotos.map((p) => p.path));

		for (const photoWithExif of result.photos) {
			try {
				// Check if photo already exists
				if (existingPaths.has(photoWithExif.photo.path)) {
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
			deleted,
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

			// Process the RAW file completely in Rust
			const result = processPhoto(
				absolutePath,
				photo.path,
				config.THUMBNAILS_DIRECTORY,
			);

			if (!result.success) {
				// Update database with failure
				await ctx.db
					.update(photosTable)
					.set({
						rawStatus: "failed",
						rawError: result.error ?? "Unknown error",
					})
					.where(eq(photosTable.id, input.id));

				return {
					success: false,
					error: result.error,
				};
			}

			// Convert clipEmbedding to Float32Array
			const clipEmbedding = result.clipEmbedding
				? new Float32Array(result.clipEmbedding)
				: undefined;

			// Update database with new metadata
			await ctx.db
				.update(photosTable)
				.set({
					width: result.width,
					height: result.height,
					phash: result.phash,
					clipEmbedding,
					rawStatus: "converted",
					rawError: null,
				})
				.where(eq(photosTable.id, input.id));

			return {
				success: true,
			};
		}),
});

// Export type for use in clients
export type AppRouter = typeof appRouter;
