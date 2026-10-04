use napi::bindgen_prelude::{Either, Null};
use napi_derive::napi;
use rayon::prelude::*;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use crate::decode::{decode_with_orientation, is_heif_source};
use crate::exif::{ExifData, METADATA_CHUNK_SIZE, extract_exif_batch, extract_exif_internal};
use crate::phash::generate_phash_from_image;
use crate::preview::get_raw_format;
use crate::thumbnails::generate_all_thumbnails_internal;
use crate::video::{is_video_file, load_video, video_mime_type};

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
  ".heic", ".heif", // Video
  ".mp4", ".mov", ".m4v",
];

/// Check if a still image or video file is supported (case-insensitive suffix)
#[napi]
pub fn is_supported_media(file_path: String) -> bool {
  let lower = file_path.to_lowercase();
  ALL_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
}

/// Get all supported extensions
#[napi]
pub fn get_supported_extensions() -> Vec<String> {
  ALL_EXTENSIONS.iter().map(|s| s.to_string()).collect()
}

const PHOTO: &str = "photo";
const VIDEO: &str = "video";

/// Unified result for any photo or video
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
  #[napi(ts_type = "'photo' | 'video'")]
  pub media_type: String,
  /// Video duration in milliseconds; `null` for photos or unknown durations.
  pub duration_ms: Either<i64, Null>,
  /// ffprobe `codec_name` of the first video stream (e.g. `h264`, `hevc`); `null` for photos.
  pub video_codec: Either<String, Null>,
}

fn nullable<T>(value: Option<T>) -> Either<T, Null> {
  value.map_or(Either::B(Null), Either::A)
}

/// Check if file is a standard image (directly decodable)
pub(crate) fn is_standard_image(file_path: &str) -> bool {
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
    media_type: if is_video_file(path) { VIDEO } else { PHOTO }.to_string(),
    duration_ms: Either::B(Null),
    video_codec: Either::B(Null),
  }
}

/// Probe a video, decode its poster frame through ffmpeg, then hash and thumbnail the
/// poster exactly like a decoded still. ffmpeg has already applied rotation metadata.
/// `result` carries the file identity, timestamps, and EXIF; failures keep them.
fn process_video(
  file_path: &str,
  thumbnails_dir: &str,
  thumbnail_path: &str,
  mut result: PhotoProcessingResult,
) -> PhotoProcessingResult {
  result.media_type = VIDEO.to_string();
  result.mime_type = video_mime_type(file_path).map(str::to_string);
  let video = match load_video(file_path) {
    Ok(video) => video,
    Err(error) => {
      result.error = Some(error);
      return result;
    }
  };
  result.width = Some(video.probe.width);
  result.height = Some(video.probe.height);
  result.duration_ms = nullable(video.duration_ms());
  result.phash = Some(generate_phash_from_image(&video.image));
  result.error = generate_all_thumbnails_internal(&video.image, thumbnail_path, thumbnails_dir)
    .err()
    .map(|error| format!("Failed to generate thumbnails: {}", error));
  result.success = result.error.is_none();
  result.video_codec = nullable(video.probe.codec);
  result
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

  // Extract EXIF (works for all formats via exiftool)
  let exif = load_exif();

  if is_video_file(file_path) {
    return process_video(
      file_path,
      thumbnails_dir,
      thumbnail_path,
      PhotoProcessingResult {
        size,
        created_at,
        modified_at,
        exif,
        ..error_result(relative_path, name, String::new())
      },
    );
  }

  // Determine if this is a RAW file
  let raw_format = get_raw_format(file_path);
  let is_raw = raw_format.is_some();

  // Check for HEIF files - by extension or magic bytes (handles mislabeled iOS files)
  let is_heif = is_heif_source(file_path);
  let orientation = exif.as_ref().and_then(|e| e.orientation);

  // Decode (HEIF, RAW preview, or standard) and apply orientation; HEIF is never rotated
  // again because libheif already applies irot/imir transforms.
  match decode_with_orientation(file_path, is_heif, orientation) {
    Ok(img) => {
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
        media_type: PHOTO.to_string(),
        duration_ms: Either::B(Null),
        video_codec: Either::B(Null),
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
        media_type: PHOTO.to_string(),
        duration_ms: Either::B(Null),
        video_codec: Either::B(Null),
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
    assert_eq!(result.media_type, "photo");
    assert_eq!(result.mime_type.as_deref(), Some("image/png"));
    assert_eq!(Option::from(result.duration_ms), None::<i64>);
    assert_eq!(Option::from(result.video_codec), None::<String>);
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

  #[test]
  fn supported_media_includes_videos_case_insensitively() {
    for path in [
      "a/clip.mp4",
      "IMG_0001.MOV",
      "x.M4v",
      "photo.JPG",
      "raw.cr3",
      "live.heic",
    ] {
      assert!(is_supported_media(path.into()), "{path}");
    }
    for path in ["clip.avi", "clip.mkv", "clip.mp4.txt", "mov", "notes.txt"] {
      assert!(!is_supported_media(path.into()), "{path}");
    }
    let extensions = get_supported_extensions();
    for video in [".mp4", ".mov", ".m4v"] {
      assert!(extensions.iter().any(|ext| ext == video));
    }
  }

  #[test]
  fn video_goes_through_poster_thumbnails_and_keeps_prefetched_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let thumbnails = temp.path().join("thumbnails");
    let clip = crate::video::tests::h264_clip(temp.path(), "clip.M4V", "1920x1080", 2.0);
    let exif = ExifData {
      camera_make: Some("Apple".into()),
      camera_model: None,
      lens_make: None,
      lens_model: None,
      focal_length: None,
      iso: None,
      aperture: None,
      shutter_speed: None,
      exposure_bias: None,
      date_taken: Some("2024:05:06 12:34:56".into()),
      gps_latitude: None,
      gps_longitude: None,
      gps_altitude: None,
      // Orientation must never be applied to posters; ffmpeg already autorotates.
      orientation: Some(6),
    };
    let result = processing_pool().unwrap().install(|| {
      process_photo_internal(
        clip.to_str().unwrap(),
        "trip/clip.M4V",
        thumbnails.to_str().unwrap(),
        ".versions/attempt/clip.M4V",
        || Some(exif),
      )
    });
    assert!(result.success, "{:?}", result.error);
    assert_eq!(result.path, "trip/clip.M4V");
    assert_eq!(result.name, "clip.M4V");
    assert_eq!(result.size, fs::metadata(&clip).unwrap().len() as i64);
    assert!(result.modified_at > 0.0);
    assert_eq!(result.media_type, "video");
    assert_eq!(result.mime_type.as_deref(), Some("video/x-m4v"));
    assert_eq!((result.width, result.height), (Some(1920), Some(1080)));
    assert_eq!(Option::from(result.duration_ms), Some(2000_i64));
    assert_eq!(
      Option::<String>::from(result.video_codec).as_deref(),
      Some("h264")
    );
    assert!(!result.is_raw && result.raw_status.is_none());
    assert!(result.phash.is_some());
    assert_eq!(
      result.exif.and_then(|exif| exif.date_taken).as_deref(),
      Some("2024:05:06 12:34:56")
    );
    // Existing fit rounding (1920x1080 -> 149x84 at the 150 px bound).
    for (size, dimensions) in [
      ("tiny", (149, 84)),
      ("small", (400, 225)),
      ("medium", (800, 450)),
      ("large", (1600, 900)),
    ] {
      let path = thumbnails.join(size).join(".versions/attempt/clip.webp");
      let thumbnail = image::open(path).unwrap();
      assert_eq!(
        (thumbnail.width(), thumbnail.height()),
        dimensions,
        "{size}"
      );
    }
  }

  #[test]
  fn failed_video_is_unsuccessful_but_keeps_identity_and_media_type() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("broken.mov");
    fs::write(&source, b"not a movie").unwrap();
    let result = processing_pool().unwrap().install(|| {
      process_photo_internal(
        source.to_str().unwrap(),
        "broken.mov",
        temp.path().join("thumbnails").to_str().unwrap(),
        "broken.mov",
        || None,
      )
    });
    assert!(!result.success);
    assert!(result.error.unwrap().starts_with("ffprobe failed"));
    assert_eq!(result.media_type, "video");
    assert_eq!(result.mime_type.as_deref(), Some("video/quicktime"));
    assert_eq!(result.size, 11);
    assert_eq!((result.width, result.height), (None, None));
    assert!(!temp.path().join("thumbnails").exists());

    let missing = processing_pool().unwrap().install(|| {
      process_photo_internal(
        "/nonexistent/clip.mp4",
        "clip.mp4",
        "unused",
        "clip.mp4",
        || None,
      )
    });
    assert!(!missing.success);
    assert_eq!(missing.media_type, "video");
  }
}
