use image::{DynamicImage, GenericImageView, ImageFormat, imageops::FilterType};
use napi_derive::napi;
use rayon::prelude::*;
use std::fs;
use std::path::Path;

use crate::orientation::apply_orientation;

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
  let resized;
  let thumbnail = if width > new_width || height > new_height {
    resized = img.resize(new_width, new_height, FilterType::Lanczos3);
    &resized
  } else {
    // Image is already smaller than target, use as-is
    img
  };

  // Create parent directory if it doesn't exist
  if let Some(parent) = Path::new(output_path).parent() {
    fs::create_dir_all(parent)
      .map_err(|e| format!("Failed to create thumbnail directory: {}", e))?;
  }

  // The image crate encoder uses lossless WebP; config.quality is not applied.
  thumbnail
    .save_with_format(output_path, ImageFormat::WebP)
    .map_err(|e| format!("Failed to save thumbnail: {}", e))?;

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn thumbnail_bytes_match_previous_clone_or_resize_path() {
    let temp = tempfile::tempdir().unwrap();
    let config = ThumbnailConfig {
      max_dimension: 32,
      quality: 80,
    };
    for (width, height) in [(8, 4), (32, 32), (80, 40), (40, 80)] {
      for alpha in [false, true] {
        let rgba = image::RgbaImage::from_fn(width, height, |x, y| {
          image::Rgba([x as u8, y as u8, (x + y) as u8, (x * 3 + y) as u8])
        });
        let img = if alpha {
          DynamicImage::ImageRgba8(rgba)
        } else {
          DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(rgba).to_rgb8())
        };
        let (new_width, new_height) = if width > height {
          (32, (32.0 / (width as f32 / height as f32)) as u32)
        } else {
          ((32.0 / (height as f32 / width as f32)) as u32, 32)
        };
        let previous = if width > new_width || height > new_height {
          img.resize(new_width, new_height, FilterType::Lanczos3)
        } else {
          img.clone()
        };
        let expected = temp.path().join("expected.webp");
        let actual = temp.path().join("actual.webp");
        previous
          .save_with_format(&expected, ImageFormat::WebP)
          .unwrap();
        generate_thumbnail_from_image(&img, &config, actual.to_str().unwrap()).unwrap();
        assert_eq!(fs::read(actual).unwrap(), fs::read(expected).unwrap());
      }
    }
  }
}

/// Generate thumbnails from a file with a custom relative path
/// Optionally accepts an orientation value to apply
#[napi]
pub fn generate_thumbnails_from_file(
  file_path: String,
  relative_path: String,
  thumbnails_base_dir: String,
  orientation: Option<u32>,
) -> napi::Result<()> {
  use crate::heif::{decode_heif, is_heif_file};
  use crate::preview::{extract_preview, is_raw_file};
  use image::ImageReader;
  use std::io::Cursor;

  // Decode the image based on file type
  let img = if is_heif_file(&file_path) {
    // HEIC/HEIF: decode using libheif
    decode_heif(&file_path)
      .map_err(|e| napi::Error::from_reason(format!("Failed to decode HEIF: {}", e)))?
  } else if is_raw_file(&file_path) {
    // RAW: extract embedded preview
    let preview = extract_preview(&file_path)
      .ok_or_else(|| napi::Error::from_reason("No embedded preview found"))?;
    ImageReader::new(Cursor::new(preview))
      .with_guessed_format()
      .map_err(|e| napi::Error::from_reason(format!("Failed to read preview: {}", e)))?
      .decode()
      .map_err(|e| napi::Error::from_reason(format!("Failed to decode preview: {}", e)))?
  } else {
    // Standard image: decode directly
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
/// Each size is generated in parallel using Rayon
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
  let path_without_ext = path_obj.with_extension("").to_string_lossy().to_string();

  let thumbnail_configs = [
    ("tiny", &sizes.tiny),
    ("small", &sizes.small),
    ("medium", &sizes.medium),
    ("large", &sizes.large),
  ];

  // Generate all 4 thumbnail sizes in parallel
  let results: Vec<Result<(), String>> = thumbnail_configs
    .par_iter()
    .map(|(size_name, config)| {
      let output_path = format!(
        "{}/{}/{}.webp",
        thumbnails_base_dir, size_name, path_without_ext
      );
      generate_thumbnail_from_image(img, config, &output_path)
    })
    .collect();

  // Return first error if any
  for result in results {
    result?;
  }

  Ok(())
}
