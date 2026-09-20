use image::ImageReader;
use napi_derive::napi;
use rayon::prelude::*;
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use crate::exif::{ExifData, METADATA_CHUNK_SIZE, extract_exif_batch, extract_exif_internal};
use crate::heif::{decode_heif, is_heif_by_magic_bytes, is_heif_file};
use crate::orientation::apply_orientation;
use crate::phash::generate_phash_from_image;
use crate::preview::{extract_preview, get_raw_format, is_raw_file};
use crate::thumbnails::generate_all_thumbnails_internal;

fn processing_threads(available: usize, configured: Option<&str>) -> Result<usize, String> {
  match configured {
    None => Ok(available.max(1)),
    Some(value) => value
      .parse::<usize>()
      .ok()
      .filter(|count| *count > 0)
      .ok_or_else(|| "PHOTO_PROCESSING_THREADS must be a positive integer".to_string()),
  }
}

pub(crate) fn processing_pool() -> napi::Result<&'static rayon::ThreadPool> {
  static POOL: LazyLock<Result<rayon::ThreadPool, String>> = LazyLock::new(|| {
    let configured = match std::env::var("PHOTO_PROCESSING_THREADS") {
      Ok(value) => Some(value),
      Err(std::env::VarError::NotPresent) => None,
      Err(error) => return Err(error.to_string()),
    };
    let available = std::thread::available_parallelism().map_or(1, usize::from);
    rayon::ThreadPoolBuilder::new()
      .num_threads(processing_threads(available, configured.as_deref())?)
      .build()
      .map_err(|error| format!("Failed to create photo processing pool: {error}"))
  });
  POOL
    .as_ref()
    .map_err(|error| napi::Error::from_reason(error.clone()))
}

/// Standard image extensions (directly decodable by image crate)
const STANDARD_EXTENSIONS: &[&str] = &[
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif",
];

/// All supported extensions
const ALL_EXTENSIONS: &[&str] = &[
  // Standard
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", // RAW
  ".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2", ".pef", ".srw", ".x3f", ".3fr",
  ".iiq", ".rwl", // HEIF
  ".heic", ".heif",
];

/// Check if file is supported
#[napi]
pub fn is_supported_image(file_path: String) -> bool {
  let lower = file_path.to_lowercase();
  ALL_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Get all supported extensions
#[napi]
pub fn get_supported_extensions() -> Vec<String> {
  ALL_EXTENSIONS.iter().map(|s| s.to_string()).collect()
}

/// Unified result for any photo type
#[napi(object)]
pub struct PhotoProcessingResult {
  pub path: String,
  pub name: String,
  pub size: i64,
  pub created_at: f64,
  pub modified_at: f64,
  pub width: Option<u32>,
  pub height: Option<u32>,
  pub mime_type: Option<String>,
  pub phash: Option<String>,
  pub exif: Option<ExifData>,
  pub is_raw: bool,
  pub raw_format: Option<String>,
  pub raw_status: Option<String>,
  pub raw_error: Option<String>,
  pub success: bool,
  pub error: Option<String>,
}

/// Check if file is a standard image (directly decodable)
fn is_standard_image(file_path: &str) -> bool {
  let lower = file_path.to_lowercase();
  STANDARD_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Get MIME type for a file
fn get_mime_type(file_path: &str, raw_format: &Option<String>, is_heif: bool) -> Option<String> {
  let lower = file_path.to_lowercase();

  if let Some(fmt) = raw_format {
    return Some(format!("image/x-{}", fmt.to_lowercase()));
  }

  // Check if it's a HEIF file (by extension or magic bytes)
  if lower.ends_with(".heic") || lower.ends_with(".heif") || is_heif {
    return Some("image/heic".to_string());
  }

  // For standard images, detect from file
  None // Will be set during decoding
}

/// Create error result
fn error_result(path: &str, name: String, error: String) -> PhotoProcessingResult {
  PhotoProcessingResult {
    path: path.to_string(),
    name,
    size: 0,
    created_at: 0.0,
    modified_at: 0.0,
    width: None,
    height: None,
    mime_type: None,
    phash: None,
    exif: None,
    is_raw: false,
    raw_format: None,
    raw_status: None,
    raw_error: None,
    success: false,
    error: Some(error),
  }
}

/// Process a single photo (any type)
pub(crate) fn process_photo_internal(
  file_path: &str,
  relative_path: &str,
  thumbnails_dir: &str,
  thumbnail_path: &str,
  load_exif: impl FnOnce() -> Option<ExifData>,
) -> PhotoProcessingResult {
  let path = Path::new(file_path);
  let name = path
    .file_name()
    .unwrap_or_default()
    .to_string_lossy()
    .to_string();

  // Get file metadata
  let metadata = match fs::metadata(file_path) {
    Ok(m) => m,
    Err(e) => return error_result(relative_path, name, format!("Failed to read file: {}", e)),
  };

  let size = metadata.len() as i64;
  let created_at = metadata
    .created()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as f64)
    .unwrap_or(0.0);
  let modified_at = metadata
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as f64)
    .unwrap_or(0.0);

  // Determine if this is a RAW file
  let raw_format = get_raw_format(file_path);
  let is_raw = raw_format.is_some();

  // Check for HEIF files - by extension or magic bytes (handles mislabeled iOS files)
  let is_heif = is_heif_file(file_path) || is_heif_by_magic_bytes(file_path);

  // Extract EXIF (works for all formats via exiftool)
  let exif = load_exif();
  let orientation = exif.as_ref().and_then(|e| e.orientation);

  // Decode image based on file type
  // Check magic bytes first to handle mislabeled HEIC files (e.g., iOS saving HEIC as .JPEG)
  let decode_result = if is_heif {
    // HEIC/HEIF: decode using libheif
    decode_heif(file_path)
  } else if is_raw_file(file_path) {
    // RAW: extract embedded preview
    match extract_preview(file_path) {
      Some(preview_bytes) => ImageReader::new(Cursor::new(preview_bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())
        .and_then(|reader| reader.decode().map_err(|e| e.to_string())),
      None => Err("No embedded preview found".to_string()),
    }
  } else if is_standard_image(file_path) {
    // Standard image: decode directly
    ImageReader::open(file_path)
      .map_err(|e| e.to_string())
      .and_then(|reader| reader.decode().map_err(|e| e.to_string()))
  } else {
    Err("Unsupported file type".to_string())
  };

  // Process the decoded image
  match decode_result {
    Ok(img) => {
      // Apply EXIF orientation — skip for HEIF because libheif already
      // applies irot/imir transforms during decode. Applying again would
      // double-rotate the image.
      let img = if is_heif {
        img
      } else {
        apply_orientation(img, orientation)
      };
      let width = img.width();
      let height = img.height();

      // Generate phash
      let phash = Some(generate_phash_from_image(&img));

      // A successful result guarantees every thumbnail was written.
      let thumbnail_error = generate_all_thumbnails_internal(&img, thumbnail_path, thumbnails_dir)
        .err()
        .map(|error| format!("Failed to generate thumbnails: {}", error));

      // Note: CLIP embeddings are generated in a batch job after scan completes
      // This makes the initial scan ~3x faster

      // Determine MIME type
      let mime_type = get_mime_type(file_path, &raw_format, is_heif).or_else(|| {
        let lower = file_path.to_lowercase();
        if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
          Some("image/jpeg".to_string())
        } else if lower.ends_with(".png") {
          Some("image/png".to_string())
        } else if lower.ends_with(".webp") {
          Some("image/webp".to_string())
        } else if lower.ends_with(".gif") {
          Some("image/gif".to_string())
        } else {
          Some("image/unknown".to_string())
        }
      });

      PhotoProcessingResult {
        path: relative_path.to_string(),
        name,
        size,
        created_at,
        modified_at,
        width: Some(width),
        height: Some(height),
        mime_type,
        phash,
        exif,
        is_raw,
        raw_format,
        raw_status: if is_raw {
          Some("converted".to_string())
        } else {
          None
        },
        raw_error: None,
        success: thumbnail_error.is_none(),
        error: thumbnail_error,
      }
    }
    Err(e) => {
      let mime_type = get_mime_type(file_path, &raw_format, is_heif);

      PhotoProcessingResult {
        path: relative_path.to_string(),
        name,
        size,
        created_at,
        modified_at,
        width: None,
        height: None,
        mime_type,
        phash: None,
        exif,
        is_raw,
        raw_format,
        raw_status: if is_raw {
          Some("failed".to_string())
        } else {
          None
        },
        raw_error: if is_raw { Some(e.clone()) } else { None },
        success: false,
        error: Some(e),
      }
    }
  }
}

/// Process a batch of photos in parallel
#[napi]
pub fn process_photos_batch(
  file_paths: Vec<String>,
  relative_paths: Vec<String>,
  thumbnails_dir: String,
) -> napi::Result<Vec<PhotoProcessingResult>> {
  let pool = processing_pool()?;
  let mut results = Vec::with_capacity(file_paths.len());
  let mut exif_wall = Duration::ZERO;
  let mut processing_wall = Duration::ZERO;
  for (chunk_index, paths) in file_paths.chunks(METADATA_CHUNK_SIZE).enumerate() {
    let started = Instant::now();
    let metadata = extract_exif_batch(paths);
    exif_wall += started.elapsed();
    let started = Instant::now();
    let chunk_results: Vec<_> = pool.install(|| {
      paths
        .par_iter()
        .zip(metadata.into_par_iter())
        .enumerate()
        .map(|(i, (path, exif))| {
          let index = chunk_index * METADATA_CHUNK_SIZE + i;
          let rel_path = relative_paths.get(index).map(|s| s.as_str()).unwrap_or("");
          process_photo_internal(path, rel_path, &thumbnails_dir, rel_path, || exif)
        })
        .collect()
    });
    processing_wall += started.elapsed();
    results.extend(chunk_results);
  }
  eprintln!(
    "Photo batch: files={} exif_wall_ms={} processing_wall_ms={}",
    file_paths.len(),
    exif_wall.as_millis(),
    processing_wall.as_millis()
  );
  Ok(results)
}

/// Process a single photo
#[napi]
pub fn process_photo(
  file_path: String,
  relative_path: String,
  thumbnails_dir: String,
) -> napi::Result<PhotoProcessingResult> {
  Ok(processing_pool()?.install(|| {
    process_photo_internal(
      &file_path,
      &relative_path,
      &thumbnails_dir,
      &relative_path,
      || extract_exif_internal(&file_path),
    )
  }))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn batch_pool_is_reused_and_bounded() {
    let pool = processing_pool().unwrap();
    assert!(std::ptr::eq(pool, processing_pool().unwrap()));
    assert!(pool.current_num_threads() > 0);
    pool.install(|| {
      (0..40).into_par_iter().for_each(|_| {
        assert_eq!(rayon::current_num_threads(), pool.current_num_threads());
      });
    });
  }

  #[test]
  fn pool_size_uses_available_capacity_or_a_positive_override() {
    assert_eq!(processing_threads(12, None).unwrap(), 12);
    assert_eq!(processing_threads(0, None).unwrap(), 1);
    assert_eq!(processing_threads(12, Some("2")).unwrap(), 2);
    for invalid in [
      "",
      "0",
      "-1",
      "1.5",
      " 2",
      "many",
      "999999999999999999999999",
    ] {
      assert!(processing_threads(12, Some(invalid)).is_err());
    }
  }

  #[test]
  fn thumbnail_failure_is_not_a_successful_photo() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("photo.png");
    image::DynamicImage::new_rgb8(32, 16).save(&source).unwrap();
    let thumbnails = temp.path().join("thumbnails");
    fs::create_dir_all(&thumbnails).unwrap();
    fs::write(thumbnails.join("medium"), b"not a directory").unwrap();

    let result = processing_pool().unwrap().install(|| {
      process_photo_internal(
        source.to_str().unwrap(),
        "photo.png",
        thumbnails.to_str().unwrap(),
        "photo.png",
        || None,
      )
    });

    assert!(!result.success);
    assert!(result.error.is_some());
  }

  #[test]
  fn successful_photo_has_all_thumbnails_and_original_phash() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("photo.png");
    let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(1800, 900, |x, y| {
      image::Rgb([x as u8, y as u8, (x ^ y) as u8])
    }));
    img.save(&source).unwrap();
    let thumbnails = temp.path().join("thumbnails");
    let result = processing_pool().unwrap().install(|| {
      process_photo_internal(
        source.to_str().unwrap(),
        "photo.png",
        thumbnails.to_str().unwrap(),
        "photo.png",
        || None,
      )
    });

    assert!(result.success, "{:?}", result.error);
    assert_eq!(result.phash, Some(generate_phash_from_image(&img)));
    for (size, dimensions) in [
      ("tiny", (150, 75)),
      ("small", (400, 200)),
      ("medium", (800, 400)),
      ("large", (1600, 800)),
    ] {
      let thumbnail = image::open(thumbnails.join(size).join("photo.webp")).unwrap();
      assert_eq!((thumbnail.width(), thumbnail.height()), dimensions);
    }
  }
}
