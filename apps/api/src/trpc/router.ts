import path from "node:path";
import { getSubscriptionToken } from "@inngest/realtime";
import { eq, like, sql } from "drizzle-orm";
import { z } from "zod";
import { config } from "@/config";
import { photoExif, photos as photosTable } from "@/db/schema";
import { inngest } from "@/inngest";
import { searchPhotosByText } from "@/services/vector-search";
import { publicProcedure, router } from "./trpc";

// Folder tree node type
export type FolderNode = {
	name: string;
	path: string;
	photoCount: number;
	children: FolderNode[];
};

export const appRouter = router({
	// Get folder tree with photo counts
	folders: publicProcedure.query(async ({ ctx }) => {
		// Get all unique folder paths from photos
		const results = await ctx.db
			.select({
				path: photosTable.path,
			})
			.from(photosTable);

		const folderMap = new Map<
			string,
			{ name: string; path: string; photoCount: number; children: FolderNode[] }
		>();

		for (const { path } of results) {
			// Get the folder part of the path (everything before the last /)
			const lastSlash = path.lastIndexOf("/");
			const folderPath = lastSlash > 0 ? path.substring(0, lastSlash) : "";

			if (folderPath) {
				// Increment count for this folder and all parent folders
				const parts = folderPath.split("/");
				let currentPath = "";

				for (let i = 0; i < parts.length; i++) {
					currentPath = i === 0 ? parts[i] : `${currentPath}/${parts[i]}`;

					if (!folderMap.has(currentPath)) {
						folderMap.set(currentPath, {
							name: parts[i],
							path: currentPath,
							photoCount: 0,
							children: [],
						});
					}

					// Only count photos in the immediate folder, not subfolders
					if (i === parts.length - 1) {
						const folder = folderMap.get(currentPath);
						if (folder) {
							folder.photoCount++;
						}
					}
				}
			}
		}

		// Build tree structure
		const rootFolders: FolderNode[] = [];

		for (const [path, folder] of folderMap) {
			const lastSlash = path.lastIndexOf("/");
			if (lastSlash === -1) {
				// Root level folder
				rootFolders.push(folder);
			} else {
				// Child folder - add to parent
				const parentPath = path.substring(0, lastSlash);
				const parent = folderMap.get(parentPath);
				if (parent) {
					parent.children.push(folder);
				}
			}
		}

		// Sort folders alphabetically
		const sortFolders = (folders: FolderNode[]): FolderNode[] => {
			return folders
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((f) => ({ ...f, children: sortFolders(f.children) }));
		};

		return {
			folders: sortFolders(rootFolders),
			totalPhotos: results.length,
		};
	}),

	// Get distinct EXIF values for filter dropdowns
	filterOptions: publicProcedure
		.input(
			z
				.object({
					folder: z.string().optional(),
				})
				.optional(),
		)
		.query(async ({ ctx, input }) => {
			const folder = input?.folder;
			const folderCondition = folder
				? sql` AND ${photosTable.path} LIKE ${`${folder}/%`}`
				: sql``;

			const camerasResult = await ctx.db.all<{ camera: string }>(sql`
				SELECT DISTINCT
					CASE
						WHEN ${photoExif.cameraModel} LIKE ${photoExif.cameraMake} || '%' THEN ${photoExif.cameraModel}
						ELSE ${photoExif.cameraMake} || ' ' || ${photoExif.cameraModel}
					END as camera
				FROM ${photoExif}
				INNER JOIN ${photosTable} ON ${photosTable.id} = ${photoExif.photoId}
				WHERE ${photoExif.cameraMake} IS NOT NULL AND ${photoExif.cameraModel} IS NOT NULL${folderCondition}
				ORDER BY camera
			`);

			const lensesResult = await ctx.db.all<{ lens: string }>(sql`
				SELECT DISTINCT ${photoExif.lensModel} as lens
				FROM ${photoExif}
				INNER JOIN ${photosTable} ON ${photosTable.id} = ${photoExif.photoId}
				WHERE ${photoExif.lensModel} IS NOT NULL${folderCondition}
				ORDER BY lens
			`);

			const isosResult = await ctx.db.all<{ iso: number }>(sql`
				SELECT DISTINCT ${photoExif.iso} as iso
				FROM ${photoExif}
				INNER JOIN ${photosTable} ON ${photosTable.id} = ${photoExif.photoId}
				WHERE ${photoExif.iso} IS NOT NULL${folderCondition}
				ORDER BY iso
			`);

			const datesResult = await ctx.db.all<{ month: string }>(sql`
				SELECT DISTINCT substr(${photoExif.dateTaken}, 1, 7) as month
				FROM ${photoExif}
				INNER JOIN ${photosTable} ON ${photosTable.id} = ${photoExif.photoId}
				WHERE ${photoExif.dateTaken} IS NOT NULL${folderCondition}
				ORDER BY month
			`);

			return {
				cameras: camerasResult.map((r) => r.camera),
				lenses: lensesResult.map((r) => r.lens),
				isos: isosResult.map((r) => r.iso),
				dates: datesResult.map((r) => r.month),
			};
		}),

	// Get all photos with EXIF data
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
		.query(async ({ ctx, input }) => {
			const filter = input?.filterRaw ?? "all";
			const folder = input?.folder;

			// Build where conditions
			const conditions = [];

			if (filter === "raw") {
				conditions.push(eq(photosTable.isRaw, true));
			} else if (filter === "standard") {
				conditions.push(eq(photosTable.isRaw, false));
			}

			if (folder) {
				// Match photos in this folder (path starts with folder/ but not in subfolders)
				// e.g., folder "01" matches "01/photo.jpg" but not "01/sub/photo.jpg"
				conditions.push(like(photosTable.path, `${folder}/%`));
			}

			if (input?.camera) {
				conditions.push(
					sql`EXISTS (SELECT 1 FROM ${photoExif} WHERE ${photoExif.photoId} = ${photosTable.id} AND (
						CASE WHEN ${photoExif.cameraModel} LIKE ${photoExif.cameraMake} || '%'
							THEN ${photoExif.cameraModel}
							ELSE ${photoExif.cameraMake} || ' ' || ${photoExif.cameraModel}
						END = ${input.camera}
					))`,
				);
			}

			if (input?.lens) {
				conditions.push(
					sql`EXISTS (SELECT 1 FROM ${photoExif} WHERE ${photoExif.photoId} = ${photosTable.id} AND ${photoExif.lensModel} = ${input.lens})`,
				);
			}

			if (input?.iso) {
				conditions.push(
					sql`EXISTS (SELECT 1 FROM ${photoExif} WHERE ${photoExif.photoId} = ${photosTable.id} AND ${photoExif.iso} = ${input.iso})`,
				);
			}

			if (input?.dateMonth) {
				conditions.push(
					sql`EXISTS (SELECT 1 FROM ${photoExif} WHERE ${photoExif.photoId} = ${photosTable.id} AND substr(${photoExif.dateTaken}, 1, 7) = ${input.dateMonth})`,
				);
			}

			const photosList = await ctx.db.query.photos.findMany({
				where:
					conditions.length > 0
						? sql`${sql.join(conditions, sql` AND `)}`
						: undefined,
				with: {
					exif: true,
				},
			});

			// If folder filter is set, also filter out subfolders
			const filteredPhotos = folder
				? photosList.filter((p) => {
						const relativePath = p.path.substring(folder.length + 1);
						return !relativePath.includes("/");
					})
				: photosList;

			const rawCount = filteredPhotos.filter((p) => p.isRaw).length;

			return {
				photos: filteredPhotos,
				total: filteredPhotos.length,
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

	// Start a scan job (Inngest-based async scan)
	scan: publicProcedure.mutation(async () => {
		try {
			const jobId = crypto.randomUUID();
			// Resolve relative paths to absolute paths for Inngest functions
			const absolutePhotoDir = path.resolve(config.PHOTO_DIRECTORY);
			const absoluteThumbnailsDir = path.resolve(config.THUMBNAILS_DIRECTORY);
			await inngest.send({
				name: "photos/scan.requested",
				data: {
					directory: absolutePhotoDir,
					thumbnailsDir: absoluteThumbnailsDir,
					jobId,
				},
			});
			return { success: true, jobId };
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			console.error("Failed to start scan job:", message);
			return { success: false, error: message };
		}
	}),

	// Get realtime subscription token for job progress
	realtimeToken: publicProcedure
		.input(z.object({ jobId: z.string() }))
		.query(async ({ input }) => {
			const token = await getSubscriptionToken(inngest, {
				channel: `job:${input.jobId}`,
				topics: ["progress"],
			});
			return { token };
		}),
});

// Export type for use in clients
export type AppRouter = typeof appRouter;
