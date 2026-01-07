import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import {
	extractPhotoMetadata,
	processRawBatchComplete,
} from "@photobrain/image-processing";
import type { NewPhoto, NewPhotoExif } from "@/db/schema";
import {
	getAllRawExtensions,
	getRawFormat,
	isRawFile,
} from "./services/raw-formats";

export interface ScanOptions {
	directory: string;
	thumbnailsDirectory: string;
	recursive?: boolean;
	supportedExtensions?: string[];
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

const DEFAULT_SUPPORTED_EXTENSIONS = [
	// Standard image formats
	".jpg",
	".jpeg",
	".png",
	".gif",
	".webp",
	".bmp",
	".tiff",
	".tif",
	".heic",
	".heif",
	// RAW formats (added dynamically)
	...getAllRawExtensions(),
];

/**
 * Scan a directory for photo files and extract metadata
 */
export async function scanDirectory(options: ScanOptions) {
	const startTime = Date.now();
	const {
		directory,
		thumbnailsDirectory,
		recursive = true,
		supportedExtensions = DEFAULT_SUPPORTED_EXTENSIONS,
	} = options;

	const photos: PhotoWithExif[] = [];
	const rawFilesToProcess: string[] = [];

	async function scanDir(currentPath: string) {
		try {
			const entries = await readdir(currentPath, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(currentPath, entry.name);

				if (entry.isDirectory() && recursive) {
					await scanDir(fullPath);
				} else if (entry.isFile()) {
					const ext = extname(entry.name).toLowerCase();
					if (supportedExtensions.includes(ext)) {
						// Collect RAW files for batch processing
						if (isRawFile(ext)) {
							rawFilesToProcess.push(fullPath);
						} else {
							// Process standard images immediately
							try {
								const photoWithExif = await extractStandardMetadata(
									fullPath,
									directory,
									thumbnailsDirectory,
								);
								photos.push(photoWithExif);
							} catch (error) {
								console.error(
									`Error extracting metadata from ${fullPath}:`,
									error,
								);
							}
						}
					}
				}
			}
		} catch (error) {
			console.error(`Error scanning directory ${currentPath}:`, error);
		}
	}

	await scanDir(directory);

	// Batch process all RAW files in parallel using Rayon
	if (rawFilesToProcess.length > 0) {
		console.log(`📷 Batch processing ${rawFilesToProcess.length} RAW files...`);
		const batchStartTime = Date.now();

		const rawPhotos = await processBatchRawFiles(
			rawFilesToProcess,
			directory,
			thumbnailsDirectory,
		);
		photos.push(...rawPhotos);

		const batchDuration = Date.now() - batchStartTime;
		console.log(
			`✅ Batch processed ${rawFilesToProcess.length} RAW files in ${batchDuration}ms (${Math.round(batchDuration / rawFilesToProcess.length)}ms avg)`,
		);
	}

	const duration = Date.now() - startTime;

	return {
		photos,
		total: photos.length,
		duration,
	};
}

/**
 * Batch process multiple RAW files completely in Rust
 * All processing (EXIF, demosaic, histogram matching, CLIP, phash, thumbnails) happens in one Rust call
 * No temp files, no large buffer transfers between JS and Rust, single JS→Rust call
 */
async function processBatchRawFiles(
	filePaths: string[],
	baseDirectory: string,
	thumbnailsDirectory: string,
): Promise<PhotoWithExif[]> {
	// Prepare relative paths and file stats
	const relativePaths: string[] = [];
	const fileStatsMap: Map<string, { size: number; birthtime: Date; mtime: Date }> = new Map();

	for (const filePath of filePaths) {
		relativePaths.push(relative(baseDirectory, filePath));
		const fileStats = await stat(filePath);
		fileStatsMap.set(filePath, fileStats);
	}

	// Process all RAW files completely in Rust (parallel via Rayon)
	// This does: EXIF extraction, demosaic, histogram matching, CLIP, phash, thumbnails
	const batchResults = processRawBatchComplete(
		filePaths,
		relativePaths,
		thumbnailsDirectory,
	);

	// Convert results to PhotoWithExif
	const photos: PhotoWithExif[] = [];

	for (let i = 0; i < filePaths.length; i++) {
		const filePath = filePaths[i];
		const result = batchResults[i];
		const ext = extname(filePath).toLowerCase();
		const rawFormat = getRawFormat(ext);
		const fileName = basename(filePath);
		const relativePath = relativePaths[i];
		const fileStats = fileStatsMap.get(filePath)!;

		// Handle failed RAW processing
		if (!result.success) {
			photos.push(
				createFailedRawPhoto(
					relativePath,
					fileName,
					fileStats,
					rawFormat,
					"failed",
					result.error ?? "RAW processing failed",
					result.exif, // EXIF from Rust
				),
			);
			continue;
		}

		// Convert CLIP embedding to Float32Array
		const clipEmbedding = result.clipEmbedding
			? new Float32Array(result.clipEmbedding)
			: undefined;

		const photo: NewPhoto = {
			path: relativePath,
			name: fileName,
			size: fileStats.size,
			createdAt: fileStats.birthtime,
			modifiedAt: fileStats.mtime,
			width: result.width,
			height: result.height,
			mimeType: `image/x-${rawFormat?.toLowerCase() ?? "raw"}`,
			phash: result.phash ?? null,
			clipEmbedding,
			isRaw: true,
			rawFormat,
			rawStatus: "converted",
			rawError: null,
		};

		// Use EXIF from Rust result
		const exif = convertRustExifToDbFormat(result.exif);
		photos.push({ photo, exif });
	}

	return photos;
}

/**
 * Extract metadata from standard image files (JPEG, PNG, etc.)
 */
async function extractStandardMetadata(
	filePath: string,
	baseDirectory: string,
	thumbnailsDirectory: string,
): Promise<PhotoWithExif> {
	// Single file read - extracts photo metadata, EXIF data, AND generates thumbnails
	const rustMetadata = extractPhotoMetadata(
		filePath,
		baseDirectory,
		thumbnailsDirectory,
	);

	// Convert clipEmbedding f64 array to Float32Array
	const clipEmbedding = rustMetadata.clipEmbedding
		? new Float32Array(rustMetadata.clipEmbedding)
		: undefined;

	const photo: NewPhoto = {
		path: rustMetadata.path,
		name: rustMetadata.name,
		size: rustMetadata.size,
		createdAt: new Date(rustMetadata.createdAt),
		modifiedAt: new Date(rustMetadata.modifiedAt),
		width: rustMetadata.width,
		height: rustMetadata.height,
		mimeType: rustMetadata.mimeType,
		phash: rustMetadata.phash,
		clipEmbedding,
	};

	// Convert Rust EXIF data to database format (already extracted in the same pass)
	const exif = convertRustExifToDbFormat(rustMetadata.exif);

	return { photo, exif };
}

// Type for EXIF data from Rust (NAPI converts snake_case to camelCase)
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
 * Create a photo record for a failed RAW conversion
 */
function createFailedRawPhoto(
	relativePath: string,
	fileName: string,
	fileStats: { size: number; birthtime: Date; mtime: Date },
	rawFormat: string | null,
	rawStatus: string,
	rawError: string,
	rawExif?: RustExifData | null,
): PhotoWithExif {
	const photo: NewPhoto = {
		path: relativePath,
		name: fileName,
		size: fileStats.size,
		createdAt: fileStats.birthtime,
		modifiedAt: fileStats.mtime,
		width: null,
		height: null,
		mimeType: `image/x-${rawFormat?.toLowerCase() ?? "raw"}`,
		phash: null,
		clipEmbedding: undefined,
		isRaw: true,
		rawFormat,
		rawStatus,
		rawError,
	};

	const exif = convertRustExifToDbFormat(rawExif);

	return { photo, exif };
}

/**
 * Convert Rust EXIF data to database format
 */
function convertRustExifToDbFormat(
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
