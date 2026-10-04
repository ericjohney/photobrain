// Bump when existing media or vectors are no longer compatible with the pipeline.
export const MEDIA_VERSION = "media-v1";
export const EMBEDDING_MODEL_VERSION = "clip-vit-b32";
// Bump when the image-quality metric or the measured thumbnail size changes;
// every photo_quality row from another version is re-measured by the backfill.
export const QUALITY_VERSION = 1;
// Bump when the face detector, recognizer, or their preprocessing changes;
// every photo_face_scan row from another version is rescanned.
export const FACE_MODEL_VERSION = "yunet-2023mar+sface-2021dec/v1";
