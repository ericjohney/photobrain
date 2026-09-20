// Re-export schema from shared package
export * from "@photobrain/db/schema";

// Keep private import identity out of public photo payloads.
export const publicPhotoColumns = {
	sourceRoot: false,
	sourceFingerprint: false,
	mediaVersion: false,
	thumbnailKey: false,
	thumbnailRoot: false,
	thumbnailFingerprint: false,
} as const;
