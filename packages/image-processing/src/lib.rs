#![deny(clippy::all)]

mod batch;
mod clip;
mod exif;
mod heif;
mod metadata;
mod phash;
mod raw;
mod thumbnails;

// Re-export public functions and types
pub use batch::{
	get_supported_extensions, is_supported_image, process_photo, process_photos_batch,
	PhotoProcessingResult,
};
pub use clip::{clip_embedding_from_bytes, clip_text_embedding};
pub use exif::{extract_exif, ExifData};
pub use metadata::{extract_photo_metadata, PhotoMetadata};
pub use phash::perceptual_hash;
pub use raw::{extract_raw_preview, process_raw_batch_complete, process_raw_complete, RawCompleteResult};
pub use thumbnails::{generate_thumbnails_from_file, ThumbnailConfig, ThumbnailSizes};
