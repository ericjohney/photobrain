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
 * Photo row as emitted to clients: private identity stripped, EXIF sidecar attached,
 * plus the RAW+JPEG pair and Live Photo fields (`pairedPhotoExtras` in
 * `services/photo-catalog.ts`). `exif` mirrors Drizzle's relational inference for
 * the reverse one-to-one relation (non-null) so tRPC client types are unchanged;
 * rows without EXIF carry `null` at runtime.
 */
export type PublicPhotoWithExif = Omit<
	Photo,
	keyof typeof publicPhotoColumns
> & {
	exif: PhotoExif;
	/** The pair partner's photo ID, or `null` when unpaired. */
	pairedPhotoId: number | null;
	/** The partner's `rawFormat` (RAW partner) or upper-cased extension (`JPG`), or `null`. */
	pairedFormat: string | null;
	/** The Live Photo motion clip's ID for the moment's visible still, or `null`. */
	motionVideoId: number | null;
};
