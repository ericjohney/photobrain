#![deny(clippy::all)]

mod batch;
mod clip;
mod discovery;
mod exif;
mod heif;
mod orientation;
mod phash;
mod preview;
mod stream;
mod thumbnails;

// Re-export public functions and types
pub use batch::{
  PhotoProcessingResult, get_supported_extensions, is_supported_image, process_photo,
  process_photos_batch,
};
pub use clip::{batch_generate_clip_embeddings, clip_text_embedding};
pub use discovery::{DiscoveryResult, discover_photos};
pub use exif::{ExifData, extract_exif};
pub use phash::generate_phash;
pub use stream::{PhotoProcessingStream, PhotoStreamResult, start_photo_processing};
pub use thumbnails::{ThumbnailConfig, ThumbnailSizes, generate_thumbnails_from_file};
