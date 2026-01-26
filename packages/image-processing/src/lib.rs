#![deny(clippy::all)]

mod batch;
mod clip;
mod discovery;
mod exif;
mod heif;
mod orientation;
mod phash;
mod preview;
mod thumbnails;

// Re-export public functions and types
pub use batch::{
	get_supported_extensions, is_supported_image, process_photo, process_photos_batch,
	process_photos_with_callback, PhotoProcessingResult,
};
pub use clip::{batch_generate_clip_embeddings, clip_text_embedding};
pub use discovery::{discover_photos, DiscoveryResult};
pub use exif::{extract_exif, ExifData};
pub use phash::generate_phash;
pub use thumbnails::{generate_thumbnails_from_file, ThumbnailConfig, ThumbnailSizes};
