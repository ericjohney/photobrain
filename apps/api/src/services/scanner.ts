import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import {
	getSupportedExtensions,
	processPhotosBatch,
} from "@photobrain/image-processing";
import type { NewPhoto, NewPhotoExif } from "@/db/schema";

export interface ScanOptions {
	directory: string;
	thumbnailsDirectory: string;
	recursive?: boolean;
}

export interface PhotoWithExif {
	photo: NewPhoto;
	exif?: Omit<NewPhotoExif, "id" | "photoId">;
}

export interface ScanResult {
	photos: PhotoWithExif[];
	total: number;
	duration: number;
}

// Get supported extensions from Rust (includes RAW, HEIF, and standard formats)
const SUPPORTED_EXTENSIONS = getSupportedExtensions();

/**
 * Scan a directory for photo files and process them
 * All file type detection and processing happens in Rust
 */
export async function scanDirectory(options: ScanOptions) {
	const startTime = Date.now();
	const { directory, thumbnailsDirectory, recursive = true } = options;

	// Collect all supported file paths
	const filePaths: string[] = [];

	async function scanDir(currentPath: string) {
		try {
			const entries = await readdir(currentPath, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(currentPath, entry.name);

				if (entry.isDirectory() && recursive) {
					await scanDir(fullPath);
				} else if (entry.isFile()) {
					const ext = extname(entry.name).toLowerCase();
					if (SUPPORTED_EXTENSIONS.includes(ext)) {
						filePaths.push(fullPath);
					}
				}
			}
		} catch (error) {
			console.error(`Error scanning directory ${currentPath}:`, error);
		}
	}

	await scanDir(directory);

	if (filePaths.length === 0) {
		return {
			photos: [],
			total: 0,
			duration: Date.now() - startTime,
		};
	}

	// Compute relative paths
	const relativePaths = filePaths.map((fp) => relative(directory, fp));

	// Process all files in Rust (handles RAW, HEIF, standard images automatically)
	console.log(`📷 Processing ${filePaths.length} photos...`);
	const batchStartTime = Date.now();

	const results = processPhotosBatch(
		filePaths,
		relativePaths,
		thumbnailsDirectory,
	);

	const batchDuration = Date.now() - batchStartTime;
	const successCount = results.filter((r) => r.success).length;
	console.log(
		`✅ Processed ${successCount}/${filePaths.length} photos in ${batchDuration}ms (${Math.round(batchDuration / filePaths.length)}ms avg)`,
	);

	// Convert results to PhotoWithExif
	const photos: PhotoWithExif[] = [];
	for (const result of results) {
		if (!result.success) {
			console.error(`Failed to process ${result.path}: ${result.error}`);
			// Still include failed photos with minimal info
			if (result.isRaw) {
				photos.push(createFailedPhoto(result));
			}
			continue;
		}

		const clipEmbedding = result.clipEmbedding
			? new Float32Array(result.clipEmbedding)
			: undefined;

		const photo: NewPhoto = {
			path: result.path,
			name: result.name,
			size: result.size,
			createdAt: new Date(result.createdAt),
			modifiedAt: new Date(result.modifiedAt),
			width: result.width ?? null,
			height: result.height ?? null,
			mimeType: result.mimeType ?? null,
			phash: result.phash ?? null,
			clipEmbedding,
			isRaw: result.isRaw,
			rawFormat: result.rawFormat ?? null,
			rawStatus: result.rawStatus ?? null,
			rawError: result.rawError ?? null,
		};

		const exif = convertExifToDbFormat(result.exif);
		photos.push({ photo, exif });
	}

	const duration = Date.now() - startTime;

	return {
		photos,
		total: photos.length,
		duration,
	};
}

// Type for EXIF data from Rust
interface RustExifData {
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
	gpsLatitude?: number | null;
	gpsLongitude?: number | null;
	gpsAltitude?: number | null;
	orientation?: number | null;
}

/**
 * Create a photo record for a failed processing
 */
function createFailedPhoto(result: {
	path: string;
	name: string;
	size: number;
	createdAt: number;
	modifiedAt: number;
	mimeType?: string | null;
	isRaw: boolean;
	rawFormat?: string | null;
	rawError?: string | null;
	exif?: RustExifData | null;
}): PhotoWithExif {
	const photo: NewPhoto = {
		path: result.path,
		name: result.name,
		size: result.size,
		createdAt: new Date(result.createdAt),
		modifiedAt: new Date(result.modifiedAt),
		width: null,
		height: null,
		mimeType: result.mimeType ?? null,
		phash: null,
		clipEmbedding: undefined,
		isRaw: result.isRaw,
		rawFormat: result.rawFormat ?? null,
		rawStatus: "failed",
		rawError: result.rawError ?? "Processing failed",
	};

	const exif = convertExifToDbFormat(result.exif);
	return { photo, exif };
}

/**
 * Convert Rust EXIF data to database format
 */
function convertExifToDbFormat(
	exifData?: RustExifData | null,
): Omit<NewPhotoExif, "id" | "photoId"> | undefined {
	if (!exifData) return undefined;

	return {
		cameraMake: exifData.cameraMake ?? undefined,
		cameraModel: exifData.cameraModel ?? undefined,
		lensMake: exifData.lensMake ?? undefined,
		lensModel: exifData.lensModel ?? undefined,
		focalLength: exifData.focalLength ?? undefined,
		iso: exifData.iso ?? undefined,
		aperture: exifData.aperture ?? undefined,
		shutterSpeed: exifData.shutterSpeed ?? undefined,
		exposureBias: exifData.exposureBias ?? undefined,
		dateTaken: exifData.dateTaken ?? undefined,
		gpsLatitude: exifData.gpsLatitude?.toString() ?? undefined,
		gpsLongitude: exifData.gpsLongitude?.toString() ?? undefined,
		gpsAltitude: exifData.gpsAltitude?.toString() ?? undefined,
	};
}
