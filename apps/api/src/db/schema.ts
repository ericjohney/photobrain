import type { Photo, PhotoExif } from "@photobrain/db/schema";

// Re-export schema from shared package
export * from "@photobrain/db/schema";

// Keep private import identity and internal review state out of public photo
// payloads. `junkDismissed` is only meaningful to the junk-review query.
export const publicPhotoColumns = {
	sourceRoot: false,
	sourceFingerprint: false,
	mediaVersion: false,
	thumbnailKey: false,
	thumbnailRoot: false,
	thumbnailFingerprint: false,
	junkDismissed: false,
} as const;

/**
 * Photo row as emitted to clients: private identity stripped, EXIF sidecar attached.
 * `exif` mirrors Drizzle's relational inference for the reverse one-to-one relation
 * (non-null) so tRPC client types are unchanged; rows without EXIF carry `null` at runtime.
 */
export type PublicPhotoWithExif = Omit<
	Photo,
	keyof typeof publicPhotoColumns
> & { exif: PhotoExif };
