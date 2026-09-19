use image::{DynamicImage, GenericImageView, imageops::FilterType};
use napi_derive::napi;
use rayon::prelude::*;
use std::borrow::Cow;
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

fn thumbnail_dimensions((width, height): (u32, u32), max_dim: u32) -> (u32, u32) {
  let (new_width, new_height) = if width > height {
    let ratio = width as f32 / height as f32;
    (max_dim, (max_dim as f32 / ratio) as u32)
  } else {
    let ratio = height as f32 / width as f32;
    ((max_dim as f32 / ratio) as u32, max_dim)
  };

  if width <= new_width && height <= new_height {
    return (width, height);
  }

  // Match image::resize's fit rounding using the original aspect ratio.
  // Recomputing from the large preview would introduce cumulative pixel drift.
  let ratio =
    (f64::from(new_width) / f64::from(width)).min(f64::from(new_height) / f64::from(height));
  (
    ((f64::from(width) * ratio).round() as u32).max(1),
    ((f64::from(height) * ratio).round() as u32).max(1),
  )
}

fn resize_thumbnail(img: &DynamicImage, dimensions: (u32, u32)) -> Cow<'_, DynamicImage> {
  if img.dimensions() == dimensions {
    Cow::Borrowed(img)
  } else {
    Cow::Owned(img.resize_exact(dimensions.0, dimensions.1, FilterType::Lanczos3))
  }
}

fn save_thumbnail(thumbnail: &DynamicImage, quality: u8, output_path: &str) -> Result<(), String> {
  // Create parent directory if it doesn't exist
  if let Some(parent) = Path::new(output_path).parent() {
    fs::create_dir_all(parent)
      .map_err(|e| format!("Failed to create thumbnail directory: {}", e))?;
  }

  let (width, height) = thumbnail.dimensions();
  let rgb;
  let rgba;
  let encoder = match thumbnail {
    DynamicImage::ImageRgb8(pixels) => webp::Encoder::from_rgb(pixels.as_raw(), width, height),
    DynamicImage::ImageRgba8(pixels) => webp::Encoder::from_rgba(pixels.as_raw(), width, height),
    _ if thumbnail.color().has_alpha() => {
      rgba = thumbnail.to_rgba8();
      webp::Encoder::from_rgba(rgba.as_raw(), width, height)
    }
    _ => {
      rgb = thumbnail.to_rgb8();
      webp::Encoder::from_rgb(rgb.as_raw(), width, height)
    }
  };
  // Lossy color previews use the configured quality; libwebp keeps alpha lossless.
  let encoded = encoder
    .encode_simple(false, f32::from(quality))
    .map_err(|e| format!("Failed to encode thumbnail: {:?}", e))?;
  fs::write(output_path, &*encoded).map_err(|e| format!("Failed to save thumbnail: {}", e))?;

  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn all_thumbnails_preserve_dimensions_and_alpha() {
    let temp = tempfile::tempdir().unwrap();
    for (width, height, expected) in [
      (
        2401,
        1601,
        [(150, 100), (399, 266), (799, 533), (1599, 1066)],
      ),
      (
        1601,
        2401,
        [(100, 150), (266, 399), (533, 799), (1066, 1599)],
      ),
      (120, 80, [(120, 80); 4]),
    ] {
      let img = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        width,
        height,
        image::Rgba([40, 80, 120, 96]),
      ));
      generate_all_thumbnails_internal(&img, "album/photo.png", temp.path().to_str().unwrap())
        .unwrap();
      for (size, dimensions) in ["tiny", "small", "medium", "large"]
        .into_iter()
        .zip(expected)
      {
        let thumbnail = image::open(temp.path().join(size).join("album/photo.webp")).unwrap();
        assert_eq!(thumbnail.dimensions(), dimensions, "{size}");
        assert!(thumbnail.color().has_alpha(), "{size}");
        assert!(
          thumbnail.to_rgba8().pixels().all(|pixel| pixel.0[3] == 96),
          "{size}"
        );
      }
    }
  }

  #[test]
  fn large_thumbnail_preserves_image_structure() {
    let temp = tempfile::tempdir().unwrap();
    let img = DynamicImage::ImageRgb8(image::RgbImage::from_fn(2401, 1601, |x, y| {
      image::Rgb([
        if x < 1200 { 200 } else { 40 },
        if y < 800 { 180 } else { 60 },
        100,
      ])
    }));
    generate_all_thumbnails_internal(&img, "photo.jpg", temp.path().to_str().unwrap()).unwrap();
    let large = image::open(temp.path().join("large/photo.webp"))
      .unwrap()
      .to_rgb8();
    for (x, y, expected) in [
      (400, 266, [200u8, 180, 100]),
      (1200, 266, [40, 180, 100]),
      (400, 800, [200, 60, 100]),
      (1200, 800, [40, 60, 100]),
    ] {
      for (actual, expected) in large.get_pixel(x, y).0.into_iter().zip(expected) {
        assert!(actual.abs_diff(expected) <= 8);
      }
    }
  }

  #[test]
  fn all_thumbnails_preserve_no_upscale_and_varying_alpha() {
    let temp = tempfile::tempdir().unwrap();
    for (width, height) in [(8, 4), (150, 150)] {
      let img = DynamicImage::ImageRgba8(image::RgbaImage::from_fn(width, height, |x, y| {
        image::Rgba([x as u8, y as u8, (x + y) as u8, (x * 3 + y) as u8])
      }));
      generate_all_thumbnails_internal(&img, "photo.png", temp.path().to_str().unwrap()).unwrap();
      let original = img.to_rgba8();
      for size in ["tiny", "small", "medium", "large"] {
        let thumbnail = image::open(temp.path().join(size).join("photo.webp")).unwrap();
        assert_eq!(thumbnail.dimensions(), (width, height), "{size}");
        assert!(thumbnail.color().has_alpha(), "{size}");
        for (actual, original) in thumbnail.to_rgba8().pixels().zip(original.pixels()) {
          assert_eq!(actual.0[3], original.0[3], "{size}");
        }
      }
    }
  }

  #[test]
  fn all_thumbnails_report_an_unwritable_destination() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("medium"), b"not a directory").unwrap();
    let img = DynamicImage::new_rgb8(16, 8);
    assert!(
      generate_all_thumbnails_internal(&img, "photo.jpg", temp.path().to_str().unwrap()).is_err()
    );
  }

  #[test]
  fn grayscale_alpha_is_preserved_when_converting_for_webp() {
    let temp = tempfile::tempdir().unwrap();
    let img = DynamicImage::ImageLumaA16(image::ImageBuffer::from_pixel(
      20,
      10,
      image::LumaA([32_896u16, 24_672]),
    ));
    generate_all_thumbnails_internal(&img, "grayscale.png", temp.path().to_str().unwrap()).unwrap();
    for size in ["tiny", "small", "medium", "large"] {
      let decoded = image::open(temp.path().join(size).join("grayscale.webp")).unwrap();
      assert_eq!(decoded.dimensions(), (20, 10), "{size}");
      assert!(decoded.color().has_alpha(), "{size}");
      for pixel in decoded.to_rgba8().pixels() {
        assert_eq!(pixel.0[3], 96, "{size}");
        for channel in &pixel.0[..3] {
          assert!(channel.abs_diff(128) <= 3, "{size}");
        }
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
/// The large preview is resized once, then bounded resize/save work runs in parallel.
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
  let original_dimensions = img.dimensions();
  let large = resize_thumbnail(
    img,
    thumbnail_dimensions(original_dimensions, sizes.large.max_dimension),
  );

  // Get the path without extension and convert to .webp
  let path_obj = Path::new(relative_path);
  let path_without_ext = path_obj.with_extension("").to_string_lossy().to_string();

  let thumbnail_configs = [
    ("tiny", &sizes.tiny),
    ("small", &sizes.small),
    ("medium", &sizes.medium),
    ("large", &sizes.large),
  ];

  // Reuse the large pixels, including a borrowed source when no resize is needed.
  thumbnail_configs
    .par_iter()
    .try_for_each(|(size_name, config)| {
      let output_path = format!(
        "{}/{}/{}.webp",
        thumbnails_base_dir, size_name, path_without_ext
      );
      let dimensions = thumbnail_dimensions(original_dimensions, config.max_dimension);
      save_thumbnail(
        &resize_thumbnail(&large, dimensions),
        config.quality,
        &output_path,
      )
    })
}
