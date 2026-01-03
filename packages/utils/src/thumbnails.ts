/**
 * Thumbnail configuration
 * Centralized source of truth for thumbnail sizes and formats
 */
export const THUMBNAIL_CONFIG = {
	sizes: {
		tiny: { maxDimension: 150, quality: 80 }, // Grid views (mobile + web)
		small: { maxDimension: 400, quality: 85 }, // Mobile preview, web modal
		medium: { maxDimension: 800, quality: 85 }, // Lightbox, tablet grid
		large: { maxDimension: 1600, quality: 90 }, // Desktop full view, high-DPI
	},
	format: "webp" as const,
} as const;

export type ThumbnailSize = keyof typeof THUMBNAIL_CONFIG.sizes;

/**
 * Generate deterministic thumbnail path from photo relative path
 * Thumbnails mirror the original directory structure
 * Example: photo at "2024/vacation/IMG_1234.jpg" -> "tiny/2024/vacation/IMG_1234.webp"
 * No database storage needed - paths are computed from photo path and size
 */
export function getThumbnailPath(
	photoRelativePath: string,
	size: ThumbnailSize,
): string {
	// Remove extension and add .webp
	const pathWithoutExt = photoRelativePath.replace(/\.[^/.]+$/, "");
	return `${size}/${pathWithoutExt}.webp`;
}

/**
 * Get all thumbnail sizes as an array
 */
export function getAllThumbnailSizes(): ThumbnailSize[] {
	return Object.keys(THUMBNAIL_CONFIG.sizes) as ThumbnailSize[];
}
