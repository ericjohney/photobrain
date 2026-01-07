import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import {
	extractExif,
	extractPhotoMetadata,
	generateThumbnailsFromFile,
} from "@photobrain/image-processing";
import type { NewPhoto, NewPhotoExif } from "@/db/schema";
import {
	batchConvertRawFiles,
	cleanupBatchConversion,
	cleanupTempConversion,
	convertRawToTemp,
	isDarktableAvailable,
} from "./services/raw-converter";
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

interface CollectedFile {
	fullPath: string;
	ext: string;
	isRaw: boolean;
}

/**
 * Scan a directory for photo files and extract metadata
 * Uses batch processing for RAW files to amortize darktable startup overhead
 */
export async function scanDirectory(options: ScanOptions) {
	const startTime = Date.now();
	const {
		directory,
		thumbnailsDirectory,
		recursive = true,
		supportedExtensions = DEFAULT_SUPPORTED_EXTENSIONS,
	} = options;

	// Phase 1: Collect all files
	const collectedFiles: CollectedFile[] = [];

	async function collectFiles(currentPath: string) {
		try {
			const entries = await readdir(currentPath, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(currentPath, entry.name);

				if (entry.isDirectory() && recursive) {
					await collectFiles(fullPath);
				} else if (entry.isFile()) {
					const ext = extname(entry.name).toLowerCase();
					if (supportedExtensions.includes(ext)) {
						collectedFiles.push({
							fullPath,
							ext,
							isRaw: isRawFile(ext),
						});
					}
				}
			}
		} catch (error) {
			console.error(`Error scanning directory ${currentPath}:`, error);
		}
	}

	await collectFiles(directory);

	const rawFiles = collectedFiles.filter((f) => f.isRaw);
	const standardFiles = collectedFiles.filter((f) => !f.isRaw);

	console.log(
		`📁 Found ${collectedFiles.length} files (${standardFiles.length} standard, ${rawFiles.length} RAW)`,
	);

	// Phase 2: Batch convert RAW files (single darktable invocation)
	let rawConversions = new Map<string, string>();
	let batchTempDir = "";

	if (rawFiles.length > 0) {
		const batchResult = await batchConvertRawFiles(
			rawFiles.map((f) => f.fullPath),
		);
		rawConversions = batchResult.conversions;
		batchTempDir = batchResult.tempDir;

		if (batchResult.failed.length > 0) {
			console.warn(
				`⚠️ ${batchResult.failed.length} RAW files failed to convert`,
			);
		}
	}

	// Phase 3: Process all files through Rust pipeline
	const photos: PhotoWithExif[] = [];

	// Process standard files
	for (const file of standardFiles) {
		try {
			const photoWithExif = await extractStandardMetadata(
				file.fullPath,
				directory,
				thumbnailsDirectory,
			);
			photos.push(photoWithExif);
		} catch (error) {
			console.error(`Error extracting metadata from ${file.fullPath}:`, error);
		}
	}

	// Process RAW files using pre-converted JPEGs
	for (const file of rawFiles) {
		try {
			const convertedPath = rawConversions.get(file.fullPath);
			const photoWithExif = await extractRawMetadataFromConverted(
				file.fullPath,
				convertedPath,
				directory,
				thumbnailsDirectory,
			);
			photos.push(photoWithExif);
		} catch (error) {
			console.error(`Error extracting metadata from ${file.fullPath}:`, error);
		}
	}

	// Cleanup batch temp directory
	await cleanupBatchConversion(batchTempDir);

	const duration = Date.now() - startTime;

	return {
		photos,
		total: photos.length,
		duration,
	};
}

/**
 * Extract metadata and EXIF data from a photo file using Rust
 * This function reads the file only ONCE and extracts all data in a single pass
 * Thumbnails are generated automatically during this process
 */
async function extractMetadata(
	filePath: string,
	baseDirectory: string,
	thumbnailsDirectory: string,
): Promise<PhotoWithExif> {
	const ext = extname(filePath).toLowerCase();

	// Handle RAW files differently
	if (isRawFile(ext)) {
		return extractRawMetadata(filePath, baseDirectory, thumbnailsDirectory);
	}

	return extractStandardMetadata(filePath, baseDirectory, thumbnailsDirectory);
}

/**
 * Extract metadata from standard image files (JPEG, PNG, etc.)
 */
async function extractStandardMetadata(
	filePath: string,
	baseDirectory: string,
	thumbnailsDirectory: string,
): Promise<PhotoWithExif> {
	const fileName = basename(filePath);
	const startTime = performance.now();

	// Single file read - extracts photo metadata, EXIF data, AND generates thumbnails
	const rustMetadata = extractPhotoMetadata(
		filePath,
		baseDirectory,
		thumbnailsDirectory,
	);

	const duration = Math.round(performance.now() - startTime);
	console.log(`⏱️  ${fileName}: ${duration}ms (rust pipeline)`);

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
	const exif = convertExifToDbFormat(rustMetadata.exif);

	return { photo, exif };
}

/**
 * Extract metadata from RAW image files
 * Flow: Extract EXIF from RAW → Convert to temp JPEG → Process JPEG → Clean up
 */
async function extractRawMetadata(
	filePath: string,
	baseDirectory: string,
	thumbnailsDirectory: string,
): Promise<PhotoWithExif> {
	const ext = extname(filePath).toLowerCase();
	const rawFormat = getRawFormat(ext);
	const fileName = basename(filePath);
	const relativePath = relative(baseDirectory, filePath);
	const timings: Record<string, number> = {};

	// Get file stats for the original RAW file
	const fileStats = await stat(filePath);

	// Extract EXIF from the RAW file directly (before conversion)
	let rawExif: ReturnType<typeof extractExif> | undefined;
	const exifStart = performance.now();
	try {
		rawExif = extractExif(filePath);
	} catch {
		// EXIF extraction failed, continue without it
	}
	timings.exif = Math.round(performance.now() - exifStart);

	// Check if darktable is available
	if (!(await isDarktableAvailable())) {
		console.warn(
			`⚠️ Cannot process RAW file ${fileName}: darktable-cli not available`,
		);
		return createFailedRawPhoto(
			relativePath,
			fileName,
			fileStats,
			rawFormat,
			"no_converter",
			"darktable-cli not found",
			rawExif,
		);
	}

	// Convert RAW to temporary JPEG
	console.log(`📷 Converting RAW file: ${fileName}`);
	const conversionResult = await convertRawToTemp(filePath);
	timings.darktable = conversionResult.duration ?? 0;

	if (!conversionResult.success || !conversionResult.outputPath) {
		console.error(
			`❌ Failed to convert RAW file ${fileName}: ${conversionResult.error}`,
		);
		return createFailedRawPhoto(
			relativePath,
			fileName,
			fileStats,
			rawFormat,
			"failed",
			conversionResult.error ?? "Unknown error",
			rawExif,
		);
	}

	try {
		// Process the converted JPEG through the standard Rust pipeline
		// Note: We pass null for thumbnailsDirectory to skip thumbnail generation here
		// because the temp file path won't produce correct thumbnail paths
		const rustStart = performance.now();
		const rustMetadata = extractPhotoMetadata(
			conversionResult.outputPath,
			baseDirectory,
			null, // Don't generate thumbnails here
		);
		timings.rustPipeline = Math.round(performance.now() - rustStart);

		// Generate thumbnails separately with the correct RAW file relative path
		// Pass orientation from original RAW EXIF data for correct rotation
		const thumbStart = performance.now();
		try {
			generateThumbnailsFromFile(
				conversionResult.outputPath,
				relativePath, // Use original RAW path for thumbnail output
				thumbnailsDirectory,
				rawExif?.orientation ?? null, // Pass orientation from RAW EXIF
			);
		} catch (error) {
			console.warn(
				`Warning: Failed to generate thumbnails for ${fileName}:`,
				error,
			);
			// Continue even if thumbnail generation fails
		}
		timings.thumbnails = Math.round(performance.now() - thumbStart);

		const total = Object.values(timings).reduce((a, b) => a + b, 0);
		console.log(
			`⏱️  ${fileName}: ${total}ms total (darktable: ${timings.darktable}ms, rust: ${timings.rustPipeline}ms, thumbnails: ${timings.thumbnails}ms, exif: ${timings.exif}ms)`,
		);

		// Convert clipEmbedding f64 array to Float32Array
		const clipEmbedding = rustMetadata.clipEmbedding
			? new Float32Array(rustMetadata.clipEmbedding)
			: undefined;

		const photo: NewPhoto = {
			// Use original RAW file path and name
			path: relativePath,
			name: fileName,
			size: fileStats.size,
			createdAt: fileStats.birthtime,
			modifiedAt: fileStats.mtime,
			// Use dimensions from converted JPEG
			width: rustMetadata.width,
			height: rustMetadata.height,
			// Use RAW-specific MIME type
			mimeType: `image/x-${rawFormat?.toLowerCase() ?? "raw"}`,
			phash: rustMetadata.phash,
			clipEmbedding,
			// RAW-specific fields
			isRaw: true,
			rawFormat,
			rawStatus: "converted",
			rawError: null,
		};

		// Prefer EXIF from original RAW file, fall back to converted JPEG's EXIF
		const exif = convertExifToDbFormat(rawExif ?? rustMetadata.exif);

		return { photo, exif };
	} finally {
		// Always clean up the temporary file
		await cleanupTempConversion(conversionResult.outputPath);
	}
}

/**
 * Extract metadata from RAW files using pre-converted JPEGs (from batch conversion)
 * This is faster because darktable has already processed all RAW files at once
 */
async function extractRawMetadataFromConverted(
	rawFilePath: string,
	convertedJpegPath: string | undefined,
	baseDirectory: string,
	thumbnailsDirectory: string,
): Promise<PhotoWithExif> {
	const ext = extname(rawFilePath).toLowerCase();
	const rawFormat = getRawFormat(ext);
	const fileName = basename(rawFilePath);
	const relativePath = relative(baseDirectory, rawFilePath);
	const timings: Record<string, number> = {};

	// Get file stats for the original RAW file
	const fileStats = await stat(rawFilePath);

	// Extract EXIF from the RAW file directly
	let rawExif: ReturnType<typeof extractExif> | undefined;
	const exifStart = performance.now();
	try {
		rawExif = extractExif(rawFilePath);
	} catch {
		// EXIF extraction failed, continue without it
	}
	timings.exif = Math.round(performance.now() - exifStart);

	// If conversion failed, return failed record
	if (!convertedJpegPath) {
		return createFailedRawPhoto(
			relativePath,
			fileName,
			fileStats,
			rawFormat,
			"failed",
			"Batch conversion failed",
			rawExif,
		);
	}

	// Process the converted JPEG through the standard Rust pipeline
	const rustStart = performance.now();
	const rustMetadata = extractPhotoMetadata(
		convertedJpegPath,
		baseDirectory,
		null, // Don't generate thumbnails here
	);
	timings.rustPipeline = Math.round(performance.now() - rustStart);

	// Generate thumbnails separately with the correct RAW file relative path
	const thumbStart = performance.now();
	try {
		generateThumbnailsFromFile(
			convertedJpegPath,
			relativePath,
			thumbnailsDirectory,
			rawExif?.orientation ?? null,
		);
	} catch (error) {
		console.warn(`Warning: Failed to generate thumbnails for ${fileName}:`, error);
	}
	timings.thumbnails = Math.round(performance.now() - thumbStart);

	const total = Object.values(timings).reduce((a, b) => a + b, 0);
	console.log(
		`⏱️  ${fileName}: ${total}ms (rust: ${timings.rustPipeline}ms, thumbnails: ${timings.thumbnails}ms, exif: ${timings.exif}ms)`,
	);

	// Convert clipEmbedding f64 array to Float32Array
	const clipEmbedding = rustMetadata.clipEmbedding
		? new Float32Array(rustMetadata.clipEmbedding)
		: undefined;

	const photo: NewPhoto = {
		path: relativePath,
		name: fileName,
		size: fileStats.size,
		createdAt: fileStats.birthtime,
		modifiedAt: fileStats.mtime,
		width: rustMetadata.width,
		height: rustMetadata.height,
		mimeType: `image/x-${rawFormat?.toLowerCase() ?? "raw"}`,
		phash: rustMetadata.phash,
		clipEmbedding,
		isRaw: true,
		rawFormat,
		rawStatus: "converted",
		rawError: null,
	};

	const exif = convertExifToDbFormat(rawExif ?? rustMetadata.exif);

	return { photo, exif };
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
	rawExif?: ReturnType<typeof extractExif>,
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

	const exif = convertExifToDbFormat(rawExif);

	return { photo, exif };
}

/**
 * Convert Rust EXIF data to database format
 */
function convertExifToDbFormat(
	exifData?: ReturnType<typeof extractExif>,
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
