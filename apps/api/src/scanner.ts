import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { NewPhoto, NewPhotoExif } from "@/db/schema";
import { extractPhotoMetadata } from "@photobrain/image-processing";

export interface ScanOptions {
	directory: string;
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
];

/**
 * Scan a directory for photo files and extract metadata
 */
export async function scanDirectory(options: ScanOptions) {
	const startTime = Date.now();
	const {
		directory,
		recursive = true,
		supportedExtensions = DEFAULT_SUPPORTED_EXTENSIONS,
	} = options;

	const photos: PhotoWithExif[] = [];

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
						try {
							const photoWithExif = await extractMetadata(fullPath, directory);
							photos.push(photoWithExif);
						} catch (error) {
							console.error(`Error extracting metadata from ${fullPath}:`, error);
						}
					}
				}
			}
		} catch (error) {
			console.error(`Error scanning directory ${currentPath}:`, error);
		}
	}

	await scanDir(directory);

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
 */
async function extractMetadata(filePath: string, baseDirectory: string): Promise<PhotoWithExif> {
	// Single file read - extracts photo metadata AND EXIF data together
	const rustMetadata = extractPhotoMetadata(filePath, baseDirectory);

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
	const exif = rustMetadata.exif
		? {
				cameraMake: rustMetadata.exif.cameraMake ?? undefined,
				cameraModel: rustMetadata.exif.cameraModel ?? undefined,
				lensMake: rustMetadata.exif.lensMake ?? undefined,
				lensModel: rustMetadata.exif.lensModel ?? undefined,
				focalLength: rustMetadata.exif.focalLength ?? undefined,
				iso: rustMetadata.exif.iso ?? undefined,
				aperture: rustMetadata.exif.aperture ?? undefined,
				shutterSpeed: rustMetadata.exif.shutterSpeed ?? undefined,
				exposureBias: rustMetadata.exif.exposureBias ?? undefined,
				dateTaken: rustMetadata.exif.dateTaken ?? undefined,
				gpsLatitude: rustMetadata.exif.gpsLatitude?.toString() ?? undefined,
				gpsLongitude: rustMetadata.exif.gpsLongitude?.toString() ?? undefined,
				gpsAltitude: rustMetadata.exif.gpsAltitude?.toString() ?? undefined,
			}
		: undefined;

	return { photo, exif };
}
