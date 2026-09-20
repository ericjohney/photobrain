import { join } from "node:path";
import {
	getThumbnailPath,
	THUMBNAIL_CONFIG,
	type ThumbnailSize,
} from "@photobrain/utils";
import { like, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { config } from "../config";
import { db } from "../db";
import { photos, scanJobs } from "../db/schema";
import { inngest } from "../inngest/client";
import { failJob, updateJobProgress } from "../inngest/progress";
import { nativeExecutor } from "../services/native-executor";
import { createScanPlan } from "../services/scan-planner";
import {
	clearScanWork,
	commitScanResult,
	getScanWorkProgress,
	initializeScanWork,
	pendingScanWork,
	scanEmbeddingPhotoIds,
} from "../services/scan-work";

const router = new Hono();

// Serve actual image file by ID
// This remains a REST endpoint as tRPC is not ideal for file streaming
router.get("/:id/file", async (c) => {
	const id = Number.parseInt(c.req.param("id"), 10);

	if (Number.isNaN(id)) {
		return c.json({ error: "Invalid photo ID" }, 400);
	}

	try {
		// Get photo from database
		const photo = await db.query.photos.findFirst({
			where: (photos, { eq }) => eq(photos.id, id),
		});

		if (!photo) {
			return c.json({ error: "Photo not found in database" }, 404);
		}

		// For RAW files, serve the large thumbnail instead of the original
		// (browsers can't display RAW files directly)
		if (photo.isRaw) {
			// Check if conversion was successful
			if (photo.rawStatus !== "converted") {
				return c.json(
					{
						error: "RAW file not converted",
						rawStatus: photo.rawStatus,
						rawError: photo.rawError,
					},
					422,
				);
			}

			// Serve the large thumbnail as the "full" image
			const thumbnailPath = join(
				photo.thumbnailRoot ?? config.THUMBNAILS_DIRECTORY,
				getThumbnailPath(photo.thumbnailKey ?? photo.path, "large"),
			);

			const thumbnailFile = Bun.file(thumbnailPath);

			if (!(await thumbnailFile.exists())) {
				return c.json({ error: "Converted image not found" }, 404);
			}

			return new Response(thumbnailFile.stream(), {
				status: 200,
				headers: {
					"Content-Type": "image/webp",
					"Cache-Control": "public, max-age=3600",
					"Content-Length": thumbnailFile.size.toString(),
					"X-Original-Format": photo.rawFormat || "RAW",
				},
			});
		}

		// Standard image: serve the original file
		const absolutePath = join(
			photo.sourceRoot ?? config.PHOTO_DIRECTORY,
			photo.path,
		);

		// Read the file using Bun.file
		const file = Bun.file(absolutePath);

		// Check if file exists
		if (!(await file.exists())) {
			return c.json({ error: "Image file not found" }, 404);
		}

		// Stream the file
		const stream = file.stream();

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": photo.mimeType || "application/octet-stream",
				"Cache-Control": "public, max-age=3600",
				"Content-Length": file.size.toString(),
			},
		});
	} catch (error) {
		console.error("Error serving image:", error);
		return c.json({ error: "Failed to serve image" }, 500);
	}
});

// Serve thumbnail by ID and size
router.get("/:id/thumbnail/:size", async (c) => {
	const id = Number.parseInt(c.req.param("id"), 10);
	const size = c.req.param("size") as ThumbnailSize;

	if (Number.isNaN(id)) {
		return c.json({ error: "Invalid photo ID" }, 400);
	}

	// Validate thumbnail size
	if (!THUMBNAIL_CONFIG.sizes[size]) {
		return c.json(
			{
				error: `Invalid thumbnail size. Must be one of: ${Object.keys(THUMBNAIL_CONFIG.sizes).join(", ")}`,
			},
			400,
		);
	}

	try {
		// Check if photo exists in database
		const photo = await db.query.photos.findFirst({
			where: (photos, { eq }) => eq(photos.id, id),
		});

		if (!photo) {
			return c.json({ error: "Photo not found in database" }, 404);
		}

		// Resolve the committed generation; unadopted legacy rows retain their old path.
		const thumbnailPath = join(
			photo.thumbnailRoot ?? config.THUMBNAILS_DIRECTORY,
			getThumbnailPath(photo.thumbnailKey ?? photo.path, size),
		);

		// Read the thumbnail file
		const file = Bun.file(thumbnailPath);

		// Check if thumbnail exists, fallback to full image if not
		if (!(await file.exists())) {
			console.warn(
				`Thumbnail not found: ${thumbnailPath}, falling back to full image`,
			);
			// Redirect to full image endpoint
			return c.redirect(`/api/photos/${id}/file`);
		}

		// Generation identity prevents same-size/same-timestamp outputs sharing an ETag.
		const mtime = file.lastModified;
		const etag = `"${encodeURIComponent(photo.thumbnailKey ?? photo.path)}-${mtime}-${file.size}"`;

		// Check conditional request — return 304 if thumbnail hasn't changed
		const ifNoneMatch = c.req.header("if-none-match");
		if (ifNoneMatch === etag) {
			return new Response(null, { status: 304 });
		}

		// Stream the thumbnail
		const stream = file.stream();

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "image/webp",
				"Cache-Control": "public, max-age=31536000, immutable",
				"Content-Length": file.size.toString(),
				ETag: etag,
				"Last-Modified": new Date(mtime).toUTCString(),
			},
		});
	} catch (error) {
		console.error("Error serving thumbnail:", error);
		return c.json({ error: "Failed to serve thumbnail" }, 500);
	}
});

// One-off endpoint to re-process HEIC thumbnails with the orientation fix.
// Call via: POST /api/photos/reprocess-heic
// Remove this endpoint after running it once.
router.post("/reprocess-heic", async (c) => {
	const jobId = crypto.randomUUID();
	try {
		const heicPhotos = db
			.select({ path: photos.path })
			.from(photos)
			.where(
				or(
					like(photos.path, "%.heic"),
					like(photos.path, "%.HEIC"),
					like(photos.path, "%.heif"),
					like(photos.path, "%.HEIF"),
				),
			)
			.all();
		if (heicPhotos.length === 0)
			return c.json({ message: "No HEIC photos found", count: 0 });
		const now = new Date();
		db.insert(scanJobs)
			.values({
				id: jobId,
				phase: "processing",
				status: "running",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		const plan = await createScanPlan(
			db,
			{
				filePaths: heicPhotos.map((photo) =>
					join(config.PHOTO_DIRECTORY, photo.path),
				),
				relativePaths: heicPhotos.map((photo) => photo.path),
			},
			config.PHOTO_DIRECTORY,
			config.THUMBNAILS_DIRECTORY,
			true,
		);
		let progress = initializeScanWork(db, jobId, plan);
		while (progress.pending > 0) {
			await nativeExecutor.consumePhotos(
				jobId,
				config.THUMBNAILS_DIRECTORY,
				() => pendingScanWork(db, jobId),
				async (id, result, thumbnailKey) => {
					const saved = await commitScanResult(
						db,
						jobId,
						id,
						result,
						thumbnailKey,
					);
					if (!saved.active) throw new Error("HEIC reprocess became terminal");
				},
			);
			progress = getScanWorkProgress(db, jobId);
		}
		if (progress.successful === 0)
			throw new Error("No HEIC photos could be processed");
		const photoIds = scanEmbeddingPhotoIds(db, jobId);
		await updateJobProgress(
			jobId,
			photoIds.length ? "scan-complete" : "completed",
			progress.processed,
			progress.total,
		);
		if (photoIds.length)
			await inngest.send({
				id: `heic-embeddings-${jobId}`,
				name: "photos/embeddings.requested",
				data: { jobId, photoIds, thumbnailsDir: config.THUMBNAILS_DIRECTORY },
			});
		return c.json({
			message: `Re-processed ${progress.successful} HEIC photos`,
			count: progress.successful,
			jobId,
		});
	} catch (error) {
		await failJob(
			jobId,
			error instanceof Error ? error : new Error(String(error)),
		);
		console.error("HEIC reprocess error:", error);
		return c.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			500,
		);
	} finally {
		try {
			await nativeExecutor.cancelPhotos(jobId);
		} catch (error) {
			console.error("Failed to drain HEIC reprocess", error);
		}
		clearScanWork(db, jobId);
	}
});

// One-off: backfill thumbnailUpdatedAt for photos that have completed
// thumbnails but no timestamp. Remove after running once.
router.post("/backfill-thumbnail-timestamps", async (c) => {
	try {
		const updatedPhotos = db
			.update(photos)
			.set({ thumbnailUpdatedAt: new Date() })
			.where(
				sql`${photos.thumbnailStatus} = 'completed' AND ${photos.thumbnailUpdatedAt} IS NULL`,
			)
			.returning({ id: photos.id })
			.all();
		return c.json({
			message: `Updated ${updatedPhotos.length} photos with thumbnailUpdatedAt`,
			count: updatedPhotos.length,
		});
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			500,
		);
	}
});

export default router;
