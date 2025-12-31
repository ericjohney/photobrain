use image::ImageReader;
use napi_derive::napi;
use std::fs;
use std::path::Path;

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
}

/// Extract basic file metadata only (dimensions, MIME type, file stats)
/// For analytics (pHash, CLIP, thumbnails) use compute_photo_analytics() after getting photo ID
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

  // Get timestamps
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

  // Read image to get dimensions and MIME type
  let (width, height, mime_type) = match ImageReader::open(&file_path) {
    Ok(reader) => {
      let format = reader.format();
      match reader.decode() {
        Ok(img) => {
          let w = img.width();
          let h = img.height();
          let mime = format.map(|f| format!("image/{}", format!("{:?}", f).to_lowercase()));
          (Some(w), Some(h), mime)
        }
        Err(_) => (None, None, None),
      }
    }
    Err(_) => (None, None, None),
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
  })
}
