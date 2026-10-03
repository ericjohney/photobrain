#![deny(clippy::all)]

mod batch;
mod clip;
mod discovery;
mod duplicates;
mod exif;
mod heif;
mod orientation;
mod phash;
mod preview;
mod quality;
mod stream;
mod thumbnails;

// Re-export public functions and types
pub use batch::{
  PhotoProcessingResult, get_supported_extensions, is_supported_image, process_photo,
  process_photos_batch,
};
pub use clip::{batch_generate_clip_embeddings, clip_text_embedding};
pub use discovery::{DiscoveryResult, discover_photos};
pub use duplicates::{NearDuplicateGroup, group_near_duplicates};
pub use phash::generate_phash;
pub use quality::{ImageQuality, analyze_image_quality};
pub use stream::{PhotoProcessingStream, PhotoStreamResult, start_photo_processing};
pub use thumbnails::{
  ThumbnailConfig, ThumbnailSizes, ThumbnailValidationItem, generate_thumbnails_from_file,
  validate_thumbnails,
};
