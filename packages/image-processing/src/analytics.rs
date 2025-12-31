use image::ImageReader;
use napi_derive::napi;

use crate::clip::generate_clip_embedding_from_image;
use crate::phash::generate_phash_from_image;
use crate::thumbnail::generate_thumbnails_from_image;

#[napi(object)]
pub struct PhotoAnalytics {
    pub phash: String,
    pub clip_embedding: Vec<f64>,
    pub thumbnail_tiny: String,
    pub thumbnail_small: String,
    pub thumbnail_medium: String,
    pub thumbnail_large: String,
}

/// Compute all photo analytics from a single image load
/// This loads the image once and computes: pHash, CLIP embedding, and all thumbnails
/// Memory optimization: Single image load, zero-copy where possible
#[napi]
pub fn compute_photo_analytics(
    file_path: String,
    thumbnail_dir: String,
    photo_id: i64,
) -> napi::Result<PhotoAnalytics> {
    // Load image once
    let img = ImageReader::open(&file_path)
        .map_err(|e| napi::Error::from_reason(format!("Failed to open image: {}", e)))?
        .decode()
        .map_err(|e| napi::Error::from_reason(format!("Failed to decode image: {}", e)))?;

    // Generate perceptual hash (borrows image)
    let phash = generate_phash_from_image(&img);

    // Generate thumbnails (borrows image)
    let thumbnail_paths = generate_thumbnails_from_image(&img, &thumbnail_dir, photo_id)?;

    // Generate CLIP embedding (consumes image)
    // This must be last since it takes ownership
    let clip_embedding = generate_clip_embedding_from_image(img)
        .map(|vec| vec.iter().map(|&f| f as f64).collect())
        .ok_or_else(|| napi::Error::from_reason("Failed to generate CLIP embedding"))?;

    Ok(PhotoAnalytics {
        phash,
        clip_embedding,
        thumbnail_tiny: thumbnail_paths.tiny,
        thumbnail_small: thumbnail_paths.small,
        thumbnail_medium: thumbnail_paths.medium,
        thumbnail_large: thumbnail_paths.large,
    })
}
