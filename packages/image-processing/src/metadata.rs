use image::ImageReader;
use napi_derive::napi;
use std::fs;
use std::path::Path;

use crate::clip::generate_clip_embedding;
use crate::phash::generate_phash;

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
}

#[napi]
pub fn extract_photo_metadata(
  file_path: String,
  base_directory: String,
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

  // Try to extract image dimensions and format
  let (width, height, mime_type) = match ImageReader::open(&file_path) {
    Ok(reader) => {
      let format = reader.format();
      match reader.decode() {
        Ok(img) => {
          let mime = format.map(|f| format!("image/{}", format!("{:?}", f).to_lowercase()));
          (Some(img.width()), Some(img.height()), mime)
        }
        Err(_) => (None, None, None),
      }
    }
    Err(_) => (None, None, None),
  };

  // Generate perceptual hash
  let phash = generate_phash(&file_path);

  // Generate CLIP embedding and convert f32 to f64
  let clip_embedding = generate_clip_embedding(&file_path)
    .map(|vec| vec.iter().map(|&f| f as f64).collect());

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
  })
}
