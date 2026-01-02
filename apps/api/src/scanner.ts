import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { NewPhoto, NewPhotoExif } from "@/db/schema";
import { extractPhotoMetadata, extractExif } from "@photobrain/image-processing";

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
 */
async function extractMetadata(filePath: string, baseDirectory: string): Promise<PhotoWithExif> {
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

	// Extract EXIF data
	const rustExif = extractExif(filePath);

	// Convert Rust EXIF data to database format
	const exif = rustExif
		? {
				cameraMake: rustExif.cameraMake ?? undefined,
				cameraModel: rustExif.cameraModel ?? undefined,
				lensMake: rustExif.lensMake ?? undefined,
				lensModel: rustExif.lensModel ?? undefined,
				focalLength: rustExif.focalLength ?? undefined,
				iso: rustExif.iso ?? undefined,
				aperture: rustExif.aperture ?? undefined,
				shutterSpeed: rustExif.shutterSpeed ?? undefined,
				exposureBias: rustExif.exposureBias ?? undefined,
				dateTaken: rustExif.dateTaken ?? undefined,
				gpsLatitude: rustExif.gpsLatitude?.toString() ?? undefined,
				gpsLongitude: rustExif.gpsLongitude?.toString() ?? undefined,
				gpsAltitude: rustExif.gpsAltitude?.toString() ?? undefined,
			}
		: undefined;

	return { photo, exif };
}
