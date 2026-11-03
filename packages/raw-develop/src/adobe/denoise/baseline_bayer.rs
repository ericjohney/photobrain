//! Standard Bayer RGB baseline used by the captured partial-strength path.
//!
//! This is distinct from the complete classical RAW developer: no second hot
//! pixel pass, green balancing, final inverse gain, or color rendering is added.
//! The surrounding partial-strength pipeline must put the neural result in the
//! same gain-balanced space and apply inverse gains after strength blending.

use super::{Tensor, Variant, invalid, raw::DecodedMosaic, tiles::Rect};
use crate::{Cancel, Negative, Result, adobe::bayer};

/// Baseline producer for the same narrow Sony readout accepted by DecodedMosaic.
pub struct BayerBaseline<'a> {
  mosaic: DecodedMosaic<'a>,
  parameters: bayer::DenoiseBaseline,
}

impl<'a> BayerBaseline<'a> {
  pub fn new(negative: &'a Negative, cancel: &Cancel) -> Result<Self> {
    let mosaic = DecodedMosaic::new_with_cancel(negative, cancel)?;
    if mosaic.variant() != Variant::Bayer {
      return Err(invalid("Bayer baseline requires a validated Bayer mosaic"));
    }
    let parameters = bayer::DenoiseBaseline::new(negative)?;
    Ok(Self { mosaic, parameters })
  }

  /// Reuse this prepared source for neural inference rather than preparing it twice.
  pub fn mosaic(&self) -> &DecodedMosaic<'a> {
    &self.mosaic
  }

  /// Produce a canonical in-bounds RGB rectangle before strength blending.
  /// The internal CFA halo repeats edge blocks; it is independent of the later
  /// denoise model's wider mirror. Output is planar, preserved-black RGB.
  pub fn render_area(&self, area: Rect, cancel: &Cancel) -> Result<Tensor> {
    cancel.check()?;
    let bounds = self.mosaic.bounds();
    if !bounds.contains(area) {
      return Err(invalid("Bayer baseline area outside source"));
    }
    let [height, width] = area.size();
    super::format::elements([3, height, width])?;
    let halo = self.parameters.halo();
    let source_width = width + 2 * halo;
    let source_height = height + 2 * halo;
    let top = area.top() as isize - halo as isize;
    let left = area.left() as isize - halo as isize;
    let phase_clamp = |value: isize, extent: i32| -> i32 {
      if value < 0 {
        value.rem_euclid(2) as i32
      } else if value >= extent as isize {
        extent - 2 + (value - extent as isize).rem_euclid(2) as i32
      } else {
        value as i32
      }
    };
    let mut source = Vec::with_capacity(source_width * source_height);
    for y in 0..source_height {
      cancel.check()?;
      let row = phase_clamp(top + y as isize, bounds.bottom());
      for x in 0..source_width {
        let column = phase_clamp(left + x as isize, bounds.right());
        source.push(self.mosaic.canonical_sample(row, column));
      }
    }
    let developed =
      self
        .parameters
        .process(&source, source_width, source_height, top, left, cancel)?;
    let n = height * width;
    let mut planar = vec![0.0; 3 * n];
    for y in 0..height {
      cancel.check()?;
      for x in 0..width {
        for c in 0..3 {
          planar[c * n + y * width + x] =
            developed.data[((y + halo) * source_width + x + halo) * 3 + c];
        }
      }
    }
    Tensor::new([3, height, width], planar)
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::Path;

  fn capture(root: &Path, stem: &str) -> (Rect, Tensor) {
    let meta: serde_json::Value =
      serde_json::from_slice(&std::fs::read(root.join(format!("{stem}.json"))).unwrap()).unwrap();
    let get = |k: &str| meta[k].as_i64().unwrap() as i32;
    let rect = Rect::new(get("t"), get("l"), get("b"), get("r")).unwrap();
    let [h, w] = rect.size();
    let c = get("planes") as usize;
    let bytes = std::fs::read(root.join(format!("{stem}.bin"))).unwrap();
    let mut data = Vec::new();
    for channel in 0..c {
      for y in 0..h {
        for x in 0..w {
          let offset = (channel * get("plane_step") as usize
            + y * get("row_step") as usize
            + x * get("col_step") as usize)
            * get("psize") as usize;
          data.push(if get("psize") == 2 {
            u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap()) as f32
              * (1.0 / 65535.0)
          } else {
            f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
          });
        }
      }
    }
    (rect, Tensor::new([c, h, w], data).unwrap())
  }

  #[test]
  fn baseline_matches_native_tiles_and_subrectangles() {
    let (Ok(root), Ok(raw)) = (
      std::env::var("RAW_DENOISE_BASELINE_FIXTURES"),
      std::env::var("RAW_DENOISE_RAW_FIXTURES"),
    ) else {
      eprintln!(
        "skipped Bayer baseline native capture: set RAW_DENOISE_BASELINE_FIXTURES/RAW_DENOISE_RAW_FIXTURES"
      );
      return;
    };
    let negative = Negative::open(Path::new(&raw).join("a1m2/12766.ARW")).unwrap();
    let baseline = BayerBaseline::new(&negative, &Cancel::never()).unwrap();
    for name in ["bayer-stages", "bayer-corner"] {
      let root = Path::new(&root).join(name);
      let (area, expected) = capture(&root, "05-output");
      let actual = baseline.render_area(area, &Cancel::never()).unwrap();
      let mismatches = actual
        .data()
        .iter()
        .zip(expected.data())
        .filter(|(a, b)| a.to_bits() != b.to_bits())
        .count();
      let maximum = actual
        .data()
        .iter()
        .zip(expected.data())
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f32, f32::max);
      assert_eq!(
        mismatches, 0,
        "Bayer baseline sample differences, max={maximum}"
      );
      let cancelled = Cancel::new();
      cancelled.cancel();
      assert!(matches!(
        baseline.render_area(area, &cancelled),
        Err(crate::Error::Cancelled)
      ));
      assert!(
        baseline
          .render_area(Rect::new(-1, 0, 4, 4).unwrap(), &Cancel::never())
          .is_err()
      );
      // Independent subrectangles exercise halo placement and alternate origin parity.
      for tile in [
        Rect::new(
          area.top() + 1,
          area.left() + 1,
          area.top() + 31,
          area.left() + 30,
        )
        .unwrap(),
        Rect::new(
          area.top() + 64,
          area.left() + 62,
          area.top() + 95,
          area.left() + 95,
        )
        .unwrap(),
      ] {
        let out = baseline.render_area(tile, &Cancel::never()).unwrap();
        let [h, w] = tile.size();
        let [_, eh, ew] = expected.shape();
        for c in 0..3 {
          for y in 0..h {
            for x in 0..w {
              assert_eq!(
                out.data()[c * h * w + y * w + x].to_bits(),
                expected.data()[c * eh * ew
                  + ((tile.top() - area.top()) as usize + y) * ew
                  + (tile.left() - area.left()) as usize
                  + x]
                  .to_bits()
              );
            }
          }
        }
      }
    }
  }
}
