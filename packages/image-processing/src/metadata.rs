use image::ImageReader;
use napi_derive::napi;
use std::fs;
use std::path::Path;

use crate::clip::generate_clip_embedding_from_image;
use crate::exif::ExifData;
use crate::phash::generate_phash_from_image;
use crate::thumbnails::generate_all_thumbnails_internal;

#[napi(object)]
pub struct PhotoMetadata {
  pub path: String,
  pub name: String,
  pub size: i64,
  pub created_at: f64,
  pub modified_at: f64,
  pub width: Option<u32>,
  pub height: Option<u32>,
  pub mime_type: Option<String>,
  pub phash: Option<String>,
  pub clip_embedding: Option<Vec<f64>>,
  pub exif: Option<ExifData>,
}

#[napi]
pub fn extract_photo_metadata(
  file_path: String,
  base_directory: String,
  thumbnails_directory: Option<String>,
) -> napi::Result<PhotoMetadata> {
  let path = Path::new(&file_path);
  let base_path = Path::new(&base_directory);

  // Get file metadata
  let metadata = fs::metadata(&file_path)
    .map_err(|e| napi::Error::from_reason(format!("Failed to read file metadata: {}", e)))?;

  // Get relative path
  let relative_path = path
    .strip_prefix(base_path)
    .unwrap_or(path)
    .to_string_lossy()
    .to_string();

  // Get file name
  let name = path
    .file_name()
    .unwrap_or_default()
    .to_string_lossy()
    .to_string();

  // Get file size
  let size = metadata.len() as i64;

  // Get timestamps as JavaScript Date objects
  let created_at = metadata
    .created()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as f64)
    .unwrap_or_else(|| 0.0);

  let modified_at = metadata
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as f64)
    .unwrap_or_else(|| 0.0);

  // Extract EXIF data from raw file (before decoding)
  // This reads the file headers only, not the full image data
  let exif = crate::exif::extract_exif(file_path.clone());

  // Read and decode the image once for metadata, phash, thumbnails, and CLIP embedding
  // Memory optimization: We read the image once and carefully manage ownership
  // to avoid cloning large raw image data
  let (width, height, mime_type, phash, clip_embedding) = match ImageReader::open(&file_path) {
    Ok(reader) => {
      let format = reader.format();
      match reader.decode() {
        Ok(img) => {
          // Extract dimension info before moving ownership
          let w = img.width();
          let h = img.height();
          let mime = format.map(|f| format!("image/{}", format!("{:?}", f).to_lowercase()));

          // Generate perceptual hash (borrows img, no copy)
          let hash = Some(generate_phash_from_image(&img));

          // Generate thumbnails if directory is provided (borrows img, no copy)
          if let Some(ref thumbs_dir) = thumbnails_directory {
            if let Err(e) = generate_all_thumbnails_internal(&img, &relative_path, thumbs_dir) {
              eprintln!("Warning: Failed to generate thumbnails for {}: {}", relative_path, e);
              // Continue processing even if thumbnails fail
            }
          }

          // Generate CLIP embedding (moves img ownership, avoids clone)
          // This must be last since it consumes the image
          let embedding = generate_clip_embedding_from_image(img)
            .map(|vec| vec.iter().map(|&f| f as f64).collect());

          (Some(w), Some(h), mime, hash, embedding)
        }
        Err(_) => (None, None, None, None, None),
      }
    }
    Err(_) => (None, None, None, None, None),
  };

  Ok(PhotoMetadata {
    path: relative_path,
    name,
    size,
    created_at,
    modified_at,
    width,
    height,
    mime_type,
    phash,
    clip_embedding,
    exif,
  })
}
