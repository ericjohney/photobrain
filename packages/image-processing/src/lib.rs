#![deny(clippy::all)]

mod batch;
mod clip;
mod exif;
mod orientation;
mod phash;
mod preview;
mod thumbnails;

// Re-export public functions and types
pub use batch::{
	get_supported_extensions, is_supported_image, process_photo, process_photos_batch,
	PhotoProcessingResult,
};
pub use clip::clip_text_embedding;
pub use exif::{extract_exif, ExifData};
pub use thumbnails::{generate_thumbnails_from_file, ThumbnailConfig, ThumbnailSizes};
