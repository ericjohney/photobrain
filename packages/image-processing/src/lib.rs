#![deny(clippy::all)]

mod analytics;
mod clip;
mod metadata;
mod phash;
mod thumbnail;

// Re-export public functions and types
pub use analytics::{compute_photo_analytics, PhotoAnalytics};
pub use clip::clip_text_embedding;
pub use metadata::{extract_photo_metadata, PhotoMetadata};
pub use phash::perceptual_hash;
pub use thumbnail::{generate_thumbnails, generate_single_thumbnail_size, ThumbnailPaths};
