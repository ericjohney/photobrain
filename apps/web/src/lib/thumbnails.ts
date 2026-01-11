import { THUMBNAIL_CONFIG, type ThumbnailSize } from "@photobrain/utils";
import { config } from "@/lib/config";

/**
 * Generate thumbnail URL for a photo
 * The API endpoint resolves the photo path from the database
 * and serves the corresponding thumbnail file
 */
export function getThumbnailUrl(photoId: number, size: ThumbnailSize): string {
	return `${config.apiUrl}/api/photos/${photoId}/thumbnail/${size}`;
}

/**
 * Generate srcset for responsive thumbnail loading
 * Browser will choose the best size based on rendered size and device pixel ratio
 */
export function getThumbnailSrcSet(photoId: number): string {
	return (Object.keys(THUMBNAIL_CONFIG.sizes) as ThumbnailSize[])
		.map(
			(size) =>
				`${getThumbnailUrl(photoId, size)} ${THUMBNAIL_CONFIG.sizes[size].maxDimension}w`,
		)
		.join(", ");
}

/**
 * Get the full-resolution image URL
 */
export function getFullImageUrl(photoId: number): string {
	return `${config.apiUrl}/api/photos/${photoId}/file`;
}
