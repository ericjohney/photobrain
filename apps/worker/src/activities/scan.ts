import fs from "node:fs";
import path from "node:path";
import {
	processPhoto,
	getSupportedExtensions,
} from "@photobrain/image-processing";
import { getThumbnailPath } from "@photobrain/utils";
import { db, photos, photoExif } from "@/db";
import { eq } from "drizzle-orm";

const supportedExtensions = new Set(
	getSupportedExtensions().map((ext) => ext.toLowerCase()),
);

/**
 * Discover all photo files in a directory recursively
 */
export async function discoverPhotos(directory: string): Promise<string[]> {
	const filePaths: string[] = [];

	async function walkDirectory(dir: string): Promise<void> {
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				// Skip hidden directories
				if (!entry.name.startsWith(".")) {
					await walkDirectory(fullPath);
				}
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if (supportedExtensions.has(ext)) {
					filePaths.push(fullPath);
				}
			}
		}
	}

	await walkDirectory(directory);
	return filePaths;
}

export interface QuickProcessResult {
	success: boolean;
	filePath: string;
	relativePath: string;
	error?: string;
	width?: number;
	height?: number;
	mimeType?: string;
	isRaw?: boolean;
	rawFormat?: string;
	exif?: {
		cameraMake?: string;
		cameraModel?: string;
		lensMake?: string;
		lensModel?: string;
		focalLength?: number;
		iso?: number;
		aperture?: string;
		shutterSpeed?: string;
		exposureBias?: string;
		dateTaken?: string;
		gpsLatitude?: string;
		gpsLongitude?: string;
		gpsAltitude?: string;
	};
}

/**
 * Quick process a single photo - extract metadata and generate thumbnails only
 * Does NOT generate CLIP embeddings or phash (those are separate background jobs)
 */
export async function quickProcessPhoto(
	filePath: string,
	baseDirectory: string,
	thumbnailsDir: string,
): Promise<QuickProcessResult> {
	const relativePath = path.relative(baseDirectory, filePath);

	try {
		// Use the Rust module but we'll skip embedding/phash for now
		// For quick processing, we still call processPhoto but ignore embedding/phash
		const result = processPhoto(filePath, relativePath, thumbnailsDir);

		if (!result) {
			return {
				success: false,
				filePath,
				relativePath,
				error: "Processing returned null",
			};
		}

		return {
			success: true,
			filePath,
			relativePath,
			width: result.width ?? undefined,
			height: result.height ?? undefined,
			mimeType: result.mimeType ?? undefined,
			isRaw: result.isRaw ?? false,
			rawFormat: result.rawFormat ?? undefined,
			exif: result.exif
				? {
						cameraMake: result.exif.cameraMake ?? undefined,
						cameraModel: result.exif.cameraModel ?? undefined,
						lensMake: result.exif.lensMake ?? undefined,
						lensModel: result.exif.lensModel ?? undefined,
						focalLength: result.exif.focalLength ?? undefined,
						iso: result.exif.iso ?? undefined,
						aperture: result.exif.aperture ?? undefined,
						shutterSpeed: result.exif.shutterSpeed ?? undefined,
						exposureBias: result.exif.exposureBias ?? undefined,
						dateTaken: result.exif.dateTaken ?? undefined,
						gpsLatitude: result.exif.gpsLatitude?.toString() ?? undefined,
						gpsLongitude: result.exif.gpsLongitude?.toString() ?? undefined,
						gpsAltitude: result.exif.gpsAltitude?.toString() ?? undefined,
					}
				: undefined,
		};
	} catch (error) {
		return {
			success: false,
			filePath,
			relativePath,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export interface SavePhotoResult {
	id: number;
	path: string;
	name: string;
	size: number;
	createdAt: Date;
	modifiedAt: Date;
	width: number | null;
	height: number | null;
	mimeType: string | null;
	isRaw: boolean;
	rawFormat: string | null;
	rawStatus: string | null;
	exif: {
		cameraMake?: string | null;
		cameraModel?: string | null;
		lensMake?: string | null;
		lensModel?: string | null;
		focalLength?: number | null;
		iso?: number | null;
		aperture?: string | null;
		shutterSpeed?: string | null;
		exposureBias?: string | null;
		dateTaken?: string | null;
		gpsLatitude?: string | null;
		gpsLongitude?: string | null;
		gpsAltitude?: string | null;
	} | null;
}

/**
 * Save a processed photo to the database
 */
export async function savePhotoToDb(
	result: QuickProcessResult,
): Promise<SavePhotoResult> {
	const stats = await fs.promises.stat(result.filePath);

	// Check if photo already exists
	const existing = await db
		.select({ id: photos.id })
		.from(photos)
		.where(eq(photos.path, result.relativePath))
		.get();

	let photoId: number;

	if (existing) {
		// Update existing photo
		await db
			.update(photos)
			.set({
				name: path.basename(result.filePath),
				size: stats.size,
				modifiedAt: stats.mtime,
				width: result.width,
				height: result.height,
				mimeType: result.mimeType,
				isRaw: result.isRaw,
				rawFormat: result.rawFormat,
				rawStatus: result.isRaw ? "converted" : null,
				thumbnailStatus: "completed",
			})
			.where(eq(photos.id, existing.id));
		photoId = existing.id;
	} else {
		// Insert new photo
		const inserted = await db
			.insert(photos)
			.values({
				path: result.relativePath,
				name: path.basename(result.filePath),
				size: stats.size,
				createdAt: stats.birthtime,
				modifiedAt: stats.mtime,
				width: result.width,
				height: result.height,
				mimeType: result.mimeType,
				isRaw: result.isRaw,
				rawFormat: result.rawFormat,
				rawStatus: result.isRaw ? "converted" : null,
				thumbnailStatus: "completed",
				embeddingStatus: "pending",
				phashStatus: "pending",
			})
			.returning({ id: photos.id });
		photoId = inserted[0].id;
	}

	// Save EXIF data if available
	if (result.exif) {
		// Delete existing EXIF data
		await db.delete(photoExif).where(eq(photoExif.photoId, photoId));

		// Insert new EXIF data
		await db.insert(photoExif).values({
			photoId,
			cameraMake: result.exif.cameraMake,
			cameraModel: result.exif.cameraModel,
			lensMake: result.exif.lensMake,
			lensModel: result.exif.lensModel,
			focalLength: result.exif.focalLength,
			iso: result.exif.iso,
			aperture: result.exif.aperture,
			shutterSpeed: result.exif.shutterSpeed,
			exposureBias: result.exif.exposureBias,
			dateTaken: result.exif.dateTaken,
			gpsLatitude: result.exif.gpsLatitude,
			gpsLongitude: result.exif.gpsLongitude,
			gpsAltitude: result.exif.gpsAltitude,
		});
	}

	// Return full photo data so it can be sent to the client
	return {
		id: photoId,
		path: result.relativePath,
		name: path.basename(result.filePath),
		size: stats.size,
		createdAt: stats.birthtime,
		modifiedAt: stats.mtime,
		width: result.width ?? null,
		height: result.height ?? null,
		mimeType: result.mimeType ?? null,
		isRaw: result.isRaw ?? false,
		rawFormat: result.rawFormat ?? null,
		rawStatus: result.isRaw ? "converted" : null,
		exif: result.exif ? {
			cameraMake: result.exif.cameraMake ?? null,
			cameraModel: result.exif.cameraModel ?? null,
			lensMake: result.exif.lensMake ?? null,
			lensModel: result.exif.lensModel ?? null,
			focalLength: result.exif.focalLength ?? null,
			iso: result.exif.iso ?? null,
			aperture: result.exif.aperture ?? null,
			shutterSpeed: result.exif.shutterSpeed ?? null,
			exposureBias: result.exif.exposureBias ?? null,
			dateTaken: result.exif.dateTaken ?? null,
			gpsLatitude: result.exif.gpsLatitude ?? null,
			gpsLongitude: result.exif.gpsLongitude ?? null,
			gpsAltitude: result.exif.gpsAltitude ?? null,
		} : null,
	};
}

/**
 * Get photo IDs that need phash processing
 */
export async function getPhotosNeedingPhash(): Promise<number[]> {
	const results = await db
		.select({ id: photos.id })
		.from(photos)
		.where(eq(photos.phashStatus, "pending"))
		.all();
	return results.map((r) => r.id);
}

/**
 * Get photo IDs that need embedding processing
 */
export async function getPhotosNeedingEmbedding(): Promise<number[]> {
	const results = await db
		.select({ id: photos.id })
		.from(photos)
		.where(eq(photos.embeddingStatus, "pending"))
		.all();
	return results.map((r) => r.id);
}
