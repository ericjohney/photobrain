import { readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { NewPhoto } from "@/db/schema";
import { extractPhotoMetadata, computePhotoAnalytics } from "@photobrain/image-processing";

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
 * Extract basic file metadata using Rust
 * Analytics (pHash, CLIP, thumbnails) computed separately with processPhotoAnalytics()
 */
async function extractMetadata(filePath: string, baseDirectory: string): Promise<NewPhoto> {
	const rustMetadata = extractPhotoMetadata(filePath, baseDirectory);

	return {
		path: rustMetadata.path,
		name: rustMetadata.name,
		size: rustMetadata.size,
		createdAt: new Date(rustMetadata.createdAt),
		modifiedAt: new Date(rustMetadata.modifiedAt),
		width: rustMetadata.width,
		height: rustMetadata.height,
		mimeType: rustMetadata.mimeType,
	};
}

/**
 * Process photo analytics after DB insertion
 * Loads image once and computes pHash, CLIP embedding, and all thumbnails
 * Returns data for separate tables
 */
export function processPhotoAnalytics(
	filePath: string,
	thumbnailDir: string,
	photoId: number,
) {
	const analytics = computePhotoAnalytics(filePath, thumbnailDir, photoId);

	return {
		phash: analytics.phash,
		clipEmbedding: new Float32Array(analytics.clipEmbedding),
		thumbnails: {
			tiny: analytics.thumbnailTiny,
			small: analytics.thumbnailSmall,
			medium: analytics.thumbnailMedium,
			large: analytics.thumbnailLarge,
		},
	};
}
