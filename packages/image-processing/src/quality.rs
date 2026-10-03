use std::panic::{AssertUnwindSafe, catch_unwind};

use image::imageops::FilterType;
use image::{GrayImage, imageops};
use napi_derive::napi;
use rayon::prelude::*;

use crate::batch::processing_pool;

/// Long-edge bound for quality measurement; larger luma planes are downscaled.
const MAX_ANALYSIS_EDGE: u32 = 512;

#[napi(object)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageQuality {
  /// Variance of the 4-neighbour 3x3 Laplacian over interior luma pixels.
  pub sharpness: f64,
  /// Mean luma, 0-255.
  pub brightness: f64,
}

/// Measure sharpness and brightness for each decodable image (typically WebP
/// thumbnails). Failed or panicking decodes yield `null` for that path only;
/// pool initialization errors reject the call.
#[napi]
pub fn analyze_image_quality(paths: Vec<String>) -> napi::Result<Vec<Option<ImageQuality>>> {
  Ok(processing_pool()?.install(|| paths.par_iter().map(|path| analyze_path(path)).collect()))
}

fn analyze_path(path: &str) -> Option<ImageQuality> {
  catch_unwind(AssertUnwindSafe(|| {
    let luma = image::open(path).ok()?.to_luma8();
    Some(measure(&bounded(luma)))
  }))
  .ok()
  .flatten()
}

/// Downscale so the long edge is at most `MAX_ANALYSIS_EDGE`, preserving aspect.
fn bounded(luma: GrayImage) -> GrayImage {
  let (width, height) = luma.dimensions();
  let long_edge = width.max(height);
  if long_edge <= MAX_ANALYSIS_EDGE {
    return luma;
  }
  let ratio = f64::from(MAX_ANALYSIS_EDGE) / f64::from(long_edge);
  let scaled = |side: u32| ((f64::from(side) * ratio).round() as u32).max(1);
  imageops::resize(&luma, scaled(width), scaled(height), FilterType::Triangle)
}

fn measure(luma: &GrayImage) -> ImageQuality {
  let (width, height) = (luma.width() as usize, luma.height() as usize);
  let pixels = luma.as_raw();
  let brightness = if pixels.is_empty() {
    0.0
  } else {
    pixels.iter().map(|&value| u64::from(value)).sum::<u64>() as f64 / pixels.len() as f64
  };

  // Interior pixels only: images narrower than 3 pixels have no Laplacian.
  let mut count = 0u64;
  let mut sum = 0f64;
  let mut sum_squares = 0f64;
  for y in 1..height.saturating_sub(1) {
    let row = y * width;
    for x in 1..width - 1 {
      let index = row + x;
      let laplacian = 4 * i32::from(pixels[index])
        - i32::from(pixels[index - 1])
        - i32::from(pixels[index + 1])
        - i32::from(pixels[index - width])
        - i32::from(pixels[index + width]);
      let value = f64::from(laplacian);
      sum += value;
      sum_squares += value * value;
      count += 1;
    }
  }
  let sharpness = if count == 0 {
    0.0
  } else {
    let mean = sum / count as f64;
    (sum_squares / count as f64 - mean * mean).max(0.0)
  };
  ImageQuality {
    sharpness,
    brightness,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use image::{DynamicImage, Luma, Rgb, RgbImage};

  fn checkerboard(size: u32, square: u32) -> RgbImage {
    RgbImage::from_fn(size, size, |x, y| {
      if (x / square + y / square) % 2 == 0 {
        Rgb([255, 255, 255])
      } else {
        Rgb([0, 0, 0])
      }
    })
  }

  fn save_webp(dir: &std::path::Path, name: &str, image: RgbImage) -> String {
    let path = dir.join(name);
    let encoded =
      webp::Encoder::from_rgb(image.as_raw(), image.width(), image.height()).encode_lossless();
    std::fs::write(&path, &*encoded).unwrap();
    path.to_string_lossy().into_owned()
  }

  #[test]
  fn sharp_checkerboard_scores_above_its_blurred_version() {
    let dir = tempfile::tempdir().unwrap();
    let sharp = checkerboard(256, 8);
    let blurred = DynamicImage::ImageRgb8(sharp.clone()).blur(5.0).to_rgb8();
    let results = analyze_image_quality(vec![
      save_webp(dir.path(), "sharp.webp", sharp),
      save_webp(dir.path(), "blurred.webp", blurred),
    ])
    .unwrap();
    let (sharp, blurred) = (results[0].unwrap(), results[1].unwrap());
    assert!(
      sharp.sharpness > blurred.sharpness * 10.0,
      "{sharp:?} vs {blurred:?}"
    );
    // Blurring redistributes but preserves mean luma.
    assert!((sharp.brightness - blurred.brightness).abs() < 2.0);
  }

  #[test]
  fn black_is_darker_than_white_and_flat_images_have_zero_sharpness() {
    let dir = tempfile::tempdir().unwrap();
    let results = analyze_image_quality(vec![
      save_webp(dir.path(), "black.webp", RgbImage::new(64, 48)),
      save_webp(
        dir.path(),
        "white.webp",
        RgbImage::from_pixel(64, 48, Rgb([255, 255, 255])),
      ),
    ])
    .unwrap();
    let (black, white) = (results[0].unwrap(), results[1].unwrap());
    assert_eq!(black.brightness, 0.0);
    assert_eq!(white.brightness, 255.0);
    assert_eq!(black.sharpness, 0.0);
    assert_eq!(white.sharpness, 0.0);
  }

  #[test]
  fn failed_paths_are_none_without_affecting_neighbours() {
    let dir = tempfile::tempdir().unwrap();
    let corrupt = dir.path().join("corrupt.webp");
    std::fs::write(&corrupt, b"RIFF0000WEBPnot an image").unwrap();
    let results = analyze_image_quality(vec![
      dir
        .path()
        .join("missing.webp")
        .to_string_lossy()
        .into_owned(),
      corrupt.to_string_lossy().into_owned(),
      save_webp(dir.path(), "ok.webp", checkerboard(32, 4)),
    ])
    .unwrap();
    assert_eq!(results[0], None);
    assert_eq!(results[1], None);
    assert!(results[2].is_some_and(|quality| quality.sharpness > 0.0));
    assert_eq!(analyze_image_quality(Vec::new()).unwrap(), Vec::new());
  }

  #[test]
  fn downscales_long_edge_and_handles_degenerate_sizes() {
    let wide = GrayImage::from_pixel(2048, 100, Luma([10]));
    assert_eq!(bounded(wide).dimensions(), (512, 25));
    let small = GrayImage::from_pixel(300, 200, Luma([10]));
    assert_eq!(bounded(small).dimensions(), (300, 200));
    let line = measure(&GrayImage::from_pixel(1, 9, Luma([200])));
    assert_eq!(
      line,
      ImageQuality {
        sharpness: 0.0,
        brightness: 200.0
      }
    );
    // An isolated bright pixel: Laplacian 4*255 at the centre, -255 at 4 neighbours.
    let mut dot = GrayImage::new(5, 5);
    dot.put_pixel(2, 2, Luma([255]));
    let quality = measure(&dot);
    let values = [
      1020.0f64, -255.0, -255.0, -255.0, -255.0, 0.0, 0.0, 0.0, 0.0,
    ];
    let mean = values.iter().sum::<f64>() / 9.0;
    let variance = values.iter().map(|v| v * v).sum::<f64>() / 9.0 - mean * mean;
    assert!((quality.sharpness - variance).abs() < 1e-6);
  }
}
