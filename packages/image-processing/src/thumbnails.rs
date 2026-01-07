use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageFormat};
use napi_derive::napi;
use std::fs;
use std::path::Path;

#[napi(object)]
pub struct ThumbnailConfig {
  pub max_dimension: u32,
  pub quality: u8,
}

#[napi(object)]
pub struct ThumbnailSizes {
  pub tiny: ThumbnailConfig,
  pub small: ThumbnailConfig,
  pub medium: ThumbnailConfig,
  pub large: ThumbnailConfig,
}

impl Default for ThumbnailSizes {
  fn default() -> Self {
    Self {
      tiny: ThumbnailConfig {
        max_dimension: 150,
        quality: 80,
      },
      small: ThumbnailConfig {
        max_dimension: 400,
        quality: 85,
      },
      medium: ThumbnailConfig {
        max_dimension: 800,
        quality: 85,
      },
      large: ThumbnailConfig {
        max_dimension: 1600,
        quality: 90,
      },
    }
  }
}

/// Generate a single thumbnail from an image
/// Maintains aspect ratio and uses Lanczos3 filter for best quality
/// Saves as WebP format for optimal compression
pub fn generate_thumbnail_from_image(
  img: &DynamicImage,
  config: &ThumbnailConfig,
  output_path: &str,
) -> Result<(), String> {
  // Calculate new dimensions maintaining aspect ratio
  let (width, height) = img.dimensions();
  let max_dim = config.max_dimension;

  let (new_width, new_height) = if width > height {
    let ratio = width as f32 / height as f32;
    (max_dim, (max_dim as f32 / ratio) as u32)
  } else {
    let ratio = height as f32 / width as f32;
    ((max_dim as f32 / ratio) as u32, max_dim)
  };

  // Only resize if image is larger than target
  let thumbnail = if width > new_width || height > new_height {
    img.resize(new_width, new_height, FilterType::Lanczos3)
  } else {
    // Image is already smaller than target, use as-is
    img.clone()
  };

  // Create parent directory if it doesn't exist
  if let Some(parent) = Path::new(output_path).parent() {
    fs::create_dir_all(parent)
      .map_err(|e| format!("Failed to create thumbnail directory: {}", e))?;
  }

  // Save as WebP with specified quality
  // Note: The image crate's WebP encoder doesn't support quality parameter directly
  // It uses lossless WebP by default, which is still much smaller than JPEG
  thumbnail
    .save_with_format(output_path, ImageFormat::WebP)
    .map_err(|e| format!("Failed to save thumbnail: {}", e))?;

  Ok(())
}

/// Apply EXIF orientation to an image
fn apply_orientation(img: DynamicImage, orientation: Option<u32>) -> DynamicImage {
  match orientation {
    Some(2) => img.fliph(),
    Some(3) => img.rotate180(),
    Some(4) => img.flipv(),
    Some(5) => img.rotate270().fliph(),
    Some(6) => img.rotate90(),
    Some(7) => img.rotate90().fliph(),
    Some(8) => img.rotate270(),
    _ => img, // 1 or None = no transformation
  }
}

/// Generate thumbnails from a file with a custom relative path
/// Used for RAW files where the source file is a temp JPEG but thumbnails should use the RAW path
/// Optionally accepts an orientation value to apply (for RAW files where EXIF is from original)
#[napi]
pub fn generate_thumbnails_from_file(
  file_path: String,
  relative_path: String,
  thumbnails_base_dir: String,
  orientation: Option<u32>,
) -> napi::Result<()> {
  use crate::heif::{decode_heif, is_heif_file};
  use image::ImageReader;

  let path = Path::new(&file_path);

  // Decode the image - use HEIF decoder for HEIF/HEIC files
  let img = if is_heif_file(path) {
    decode_heif(path).map_err(|e| napi::Error::from_reason(format!("Failed to decode HEIF: {}", e)))?
  } else {
    ImageReader::open(&file_path)
      .map_err(|e| napi::Error::from_reason(format!("Failed to open image: {}", e)))?
      .decode()
      .map_err(|e| napi::Error::from_reason(format!("Failed to decode image: {}", e)))?
  };

  // Apply orientation if provided
  let img = apply_orientation(img, orientation);

  generate_all_thumbnails_internal(&img, &relative_path, &thumbnails_base_dir)
    .map_err(|e| napi::Error::from_reason(e))
}

/// Generate all thumbnail sizes from an image based on the relative file path
/// Thumbnails mirror the original directory structure
/// Example: photo at "2024/vacation/IMG_1234.jpg" creates thumbnails at:
///   - thumbnails/tiny/2024/vacation/IMG_1234.webp
///   - thumbnails/small/2024/vacation/IMG_1234.webp
///   - etc.
pub fn generate_all_thumbnails_internal(
  img: &DynamicImage,
  relative_path: &str,
  thumbnails_base_dir: &str,
) -> Result<(), String> {
  let sizes = ThumbnailSizes::default();

  // Get the path without extension and convert to .webp
  let path_obj = Path::new(relative_path);
  let path_without_ext = path_obj
    .with_extension("")
    .to_string_lossy()
    .to_string();

  let thumbnail_configs = [
    ("tiny", &sizes.tiny),
    ("small", &sizes.small),
    ("medium", &sizes.medium),
    ("large", &sizes.large),
  ];

  for (size_name, config) in thumbnail_configs {
    // Mirror the directory structure: thumbnails/{size}/{relative_path}.webp
    let output_path = format!("{}/{}/{}.webp", thumbnails_base_dir, size_name, path_without_ext);
    generate_thumbnail_from_image(img, config, &output_path)?;
  }

  Ok(())
}
