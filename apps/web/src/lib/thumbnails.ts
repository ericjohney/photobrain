import { THUMBNAIL_CONFIG, type ThumbnailSize } from "@photobrain/utils";
import { config } from "@/lib/config";

/**
 * Generate thumbnail URL for a photo
 * The API endpoint resolves the photo path from the database
 * and serves the corresponding thumbnail file
 */
export function getThumbnailUrl(photoId: number, size: ThumbnailSize, updatedAt?: Date | string | null): string {
	const base = `${config.apiUrl}/api/photos/${photoId}/thumbnail/${size}`;
	if (!updatedAt) return base;
	const ts = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
	return `${base}?v=${ts}`;
}

/**
 * Generate srcset for responsive thumbnail loading
 * Browser will choose the best size based on rendered size and device pixel ratio
 */
export function getThumbnailSrcSet(photoId: number, updatedAt?: Date | string | null): string {
	return (Object.keys(THUMBNAIL_CONFIG.sizes) as ThumbnailSize[])
		.map((size) => `${getThumbnailUrl(photoId, size, updatedAt)} ${THUMBNAIL_CONFIG.sizes[size].maxDimension}w`)
		.join(", ");
}

/**
 * Get the full-resolution image URL
 */
export function getFullImageUrl(photoId: number): string {
	return `${config.apiUrl}/api/photos/${photoId}/file`;
}
