use std::panic::{AssertUnwindSafe, catch_unwind};

use image::imageops::FilterType;
use image::{GrayImage, imageops};
use napi_derive::napi;
use rayon::prelude::*;

use crate::batch::processing_pool;

/// Long-edge bound for quality measurement; larger luma planes are downscaled.
const MAX_ANALYSIS_EDGE: u32 = 512;
/// Sharpness is the highest Laplacian variance among up to `GRID` x `GRID`
/// tiles of the interior, so a sharp subject surrounded by sky, fog, or shadow
/// is not averaged into a blur score.
const GRID: usize = 4;
/// Tiles narrower than this (in Laplacian samples) merge, so tiny images are
/// measured as one region instead of near-constant single-pixel tiles.
const MIN_TILE: usize = 8;

#[napi(object)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageQuality {
  /// Highest variance of the 4-neighbour 3x3 Laplacian among interior tiles.
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
  let (inner_width, inner_height) = (width.saturating_sub(2), height.saturating_sub(2));
  let columns = (inner_width / MIN_TILE).clamp(1, GRID);
  let rows = (inner_height / MIN_TILE).clamp(1, GRID);
  // Per tile: count, sum, sum of squares.
  let mut tiles = [(0u64, 0f64, 0f64); GRID * GRID];
  for y in 1..height.saturating_sub(1) {
    let row = y * width;
    let tile_row = (y - 1) * rows / inner_height * columns;
    for x in 1..width - 1 {
      let index = row + x;
      let laplacian = 4 * i32::from(pixels[index])
        - i32::from(pixels[index - 1])
        - i32::from(pixels[index + 1])
        - i32::from(pixels[index - width])
        - i32::from(pixels[index + width]);
      let value = f64::from(laplacian);
      let tile = &mut tiles[tile_row + (x - 1) * columns / inner_width];
      tile.0 += 1;
      tile.1 += value;
      tile.2 += value * value;
    }
  }
  let sharpness = tiles
    .iter()
    .filter(|(count, _, _)| *count > 0)
    .map(|&(count, sum, sum_squares)| {
      let mean = sum / count as f64;
      (sum_squares / count as f64 - mean * mean).max(0.0)
    })
    .fold(0.0, f64::max);
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
  fn small_sharp_region_on_a_flat_background_is_not_blurry() {
    // A sharp subject filling one tile of an otherwise flat frame (sky, fog):
    // whole-frame variance would be ~1/16 of the subject's.
    let full = checkerboard(256, 4);
    let sparse = RgbImage::from_fn(256, 256, |x, y| {
      if x < 64 && y < 64 {
        *full.get_pixel(x, y)
      } else {
        Rgb([128, 128, 128])
      }
    });
    let blurred = DynamicImage::ImageRgb8(full.clone()).blur(5.0).to_rgb8();
    let dir = tempfile::tempdir().unwrap();
    let results = analyze_image_quality(vec![
      save_webp(dir.path(), "full.webp", full),
      save_webp(dir.path(), "sparse.webp", sparse),
      save_webp(dir.path(), "blurred.webp", blurred),
    ])
    .unwrap();
    let (full, sparse, blurred) = (
      results[0].unwrap(),
      results[1].unwrap(),
      results[2].unwrap(),
    );
    assert!(
      sparse.sharpness > full.sharpness * 0.8,
      "{sparse:?} vs {full:?}"
    );
    assert!(
      sparse.sharpness > blurred.sharpness * 10.0,
      "{sparse:?} vs {blurred:?}"
    );
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
