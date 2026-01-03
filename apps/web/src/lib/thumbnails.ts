import type { ThumbnailSize } from "@photobrain/utils";
import { config } from "@/lib/config";

/**
 * Generate thumbnail URL for a photo
 * Uses deterministic paths based on photo ID and size
 */
export function getThumbnailUrl(photoId: number, size: ThumbnailSize): string {
	return `${config.apiUrl}/api/photos/${photoId}/thumbnail/${size}`;
}

/**
 * Get the full-resolution image URL
 */
export function getFullImageUrl(photoId: number): string {
	return `${config.apiUrl}/api/photos/${photoId}/file`;
}
