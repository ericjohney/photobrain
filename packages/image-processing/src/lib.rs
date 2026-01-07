#![deny(clippy::all)]

mod clip;
mod exif;
mod heif;
mod metadata;
mod phash;
mod thumbnails;

// Re-export public functions and types
pub use clip::clip_text_embedding;
pub use exif::{extract_exif, ExifData};
pub use metadata::{extract_photo_metadata, PhotoMetadata};
pub use phash::perceptual_hash;
pub use thumbnails::{generate_thumbnails_from_file, ThumbnailConfig, ThumbnailSizes};
