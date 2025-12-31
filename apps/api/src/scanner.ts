import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { NewPhoto } from "@/db/schema";
import { extractPhotoMetadata, generateThumbnails } from "@photobrain/image-processing";

export interface ScanOptions {
	directory: string;
	recursive?: boolean;
	supportedExtensions?: string[];
}

export interface ScanResult {
	photos: NewPhoto[];
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

	const photos: NewPhoto[] = [];

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
							const metadata = await extractMetadata(fullPath, directory);
							photos.push(metadata);
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
 * Extract metadata from a photo file using Rust
 * Note: Thumbnails are not generated during initial scan (requires photo ID from database)
 * Use generateThumbnailsForPhoto() after inserting to database
 */
async function extractMetadata(filePath: string, baseDirectory: string): Promise<NewPhoto> {
	// Pass null for thumbnailDir and photoId during initial scan
	// Thumbnails will be generated in a separate pass after database insertion
	const rustMetadata = extractPhotoMetadata(filePath, baseDirectory, null, null);

	// Convert clipEmbedding f64 array to Float32Array
	const clipEmbedding = rustMetadata.clipEmbedding
		? new Float32Array(rustMetadata.clipEmbedding)
		: undefined;

	return {
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
		thumbnailTiny: rustMetadata.thumbnailTiny,
		thumbnailSmall: rustMetadata.thumbnailSmall,
		thumbnailMedium: rustMetadata.thumbnailMedium,
		thumbnailLarge: rustMetadata.thumbnailLarge,
	};
}

/**
 * Generate thumbnails for a photo that's already in the database
 * This loads the image once and generates all 4 thumbnail sizes
 */
export function generateThumbnailsForPhoto(
	filePath: string,
	thumbnailDir: string,
	photoId: number,
) {
	try {
		const thumbnailPaths = generateThumbnails(filePath, thumbnailDir, photoId);
		return {
			thumbnailTiny: thumbnailPaths.tiny,
			thumbnailSmall: thumbnailPaths.small,
			thumbnailMedium: thumbnailPaths.medium,
			thumbnailLarge: thumbnailPaths.large,
		};
	} catch (error) {
		console.error(`Error generating thumbnails for photo ${photoId}:`, error);
		return {
			thumbnailTiny: null,
			thumbnailSmall: null,
			thumbnailMedium: null,
			thumbnailLarge: null,
		};
	}
}
