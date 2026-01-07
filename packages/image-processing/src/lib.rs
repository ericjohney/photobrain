#![deny(clippy::all)]

mod clip;
mod exif;
mod heif;
mod metadata;
mod phash;
mod raw;
mod thumbnails;

// Re-export public functions and types
pub use clip::{clip_embedding_from_bytes, clip_text_embedding};
pub use exif::{extract_exif, ExifData};
pub use metadata::{extract_photo_metadata, PhotoMetadata};
pub use phash::perceptual_hash;
pub use raw::{
	extract_raw_preview, process_raw_batch, process_raw_batch_complete, process_raw_complete,
	process_raw_half_size, process_raw_neutral_only, process_raw_with_histogram_matching,
	RawCompleteResult, RawProcessingResult,
};
pub use thumbnails::{generate_thumbnails_from_file, ThumbnailConfig, ThumbnailSizes};
