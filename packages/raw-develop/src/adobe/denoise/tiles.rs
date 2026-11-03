//! Observed denoise tile rectangles, without image-border or scheduling policy.
//!
//! Reconstructed from DNG Converter 18.7 arm64:
//! - Bayer `DoCalcModelAreas`: 0x100762da4; phase adjustment: 0x100e34068.
//! - X-Trans `DoCalcModelAreas`: 0x10076324c; phase adjustment: 0x100e340a8.
//! - Dense RAW `DoCalcModelAreas`: 0x100763704 (ARM64 disassembly).
//! - `CalcModelAreas` validation: 0x100e336b0.
//! - Calculator construction: 0x100762a20 (Bayer), 0x100762ec8 (X-Trans),
//!   0x100763370 (dense RAW, used by both stage3 and panorama loaders).
//!
//! Signed phase behavior was also checked against those ARM64 instructions.
//! These routines place one model tile around an already selected pipe rectangle.
//! They do not determine Adobe's traversal stride, source padding, normalization,
//! or output blending. Source rectangles can extend beyond the image bounds.

use super::{Tensor, Variant};
use crate::{Error, Result};

fn bad(message: &str) -> Error {
  Error::Malformed(format!("denoise tile: {message}"))
}

/// Nonempty half-open rectangle in signed `(top,left,bottom,right)` coordinates.
/// Negative coordinates retain the sensor/CFA phase through the model halo.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
  top: i32,
  left: i32,
  bottom: i32,
  right: i32,
}

impl Rect {
  /// Reject empty/inverted rectangles and dimensions outside signed i32 range.
  /// This API accepts only actual pixel work; it does not represent DNG's empty
  /// rectangle sentinels.
  pub fn new(top: i32, left: i32, bottom: i32, right: i32) -> Result<Self> {
    let height = bottom
      .checked_sub(top)
      .ok_or_else(|| bad("height overflow"))?;
    let width = right
      .checked_sub(left)
      .ok_or_else(|| bad("width overflow"))?;
    if height <= 0 || width <= 0 {
      return Err(bad("expected a nonempty rectangle"));
    }
    Ok(Self {
      top,
      left,
      bottom,
      right,
    })
  }

  pub fn as_array(self) -> [i32; 4] {
    [self.top, self.left, self.bottom, self.right]
  }

  /// Spatial shape in `(height,width)` order, matching a tensor's last two axes.
  pub fn size(self) -> [usize; 2] {
    [
      (self.bottom - self.top) as usize,
      (self.right - self.left) as usize,
    ]
  }

  pub fn top(self) -> i32 {
    self.top
  }
  pub fn left(self) -> i32 {
    self.left
  }
  pub fn bottom(self) -> i32 {
    self.bottom
  }
  pub fn right(self) -> i32 {
    self.right
  }

  pub fn contains(self, other: Self) -> bool {
    self.top <= other.top
      && self.left <= other.left
      && self.bottom >= other.bottom
      && self.right >= other.right
  }
}

/// Placement of one model input and output around requested destination pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TileGeometry {
  /// Destination rectangle requested by the caller, in image coordinates.
  pub requested: Rect,
  /// Full 1024-square model input, in image coordinates (possibly negative).
  pub source: Rect,
  /// Model's cropped output in image coordinates, 800 or 864 pixels per edge.
  pub output: Rect,
  /// Observed calculators set this equal to `output`; no additional inset.
  pub valid: Rect,
}

impl TileGeometry {
  /// Copy the requested pixels from a three-plane model output. This is the
  /// observed zero-offset common postprocess, before inverse transfer/gain.
  pub fn crop_model_output(self, tensor: &Tensor) -> Result<Tensor> {
    let [height, width] = self.output.size();
    if tensor.shape() != [3, height, width] {
      return Err(bad("tensor shape does not match model output rectangle"));
    }
    let crop = self.output_crop()?;
    let [crop_height, crop_width] = crop.size();
    let mut data = Vec::with_capacity(3 * crop_height * crop_width);
    for channel in 0..3 {
      for row in 0..crop_height {
        let start =
          channel * height * width + (crop.top() as usize + row) * width + crop.left() as usize;
        data.extend_from_slice(&tensor.data()[start..start + crop_width]);
      }
    }
    Tensor::new([3, crop_height, crop_width], data)
  }

  /// Maximum supported destination pipe edge, not a claim about traversal stride.
  pub fn max_pipe_edge(variant: Variant) -> i32 {
    match variant {
      Variant::Bayer => 799,
      Variant::Xtrans => 859,
      Variant::LinearRaw | Variant::PanoramaRaw => 796,
      Variant::XtransDetails => 465, // Separate 512-square baseline wrapper.
    }
  }

  /// Reproduce the observed source, output and valid rectangles for each variant.
  ///
  /// i32-overflow cases return an error rather than wrapping an image address.
  /// The caller must supply the canonical sensor coordinate system: Bayer
  /// source origins align to even rows and odd columns; X-Trans origins align
  /// to multiples of six in both axes. Dense RAW outputs align to multiples of
  /// four. These alignments also apply to negative coordinates.
  pub fn calculate(variant: Variant, requested: Rect) -> Result<Self> {
    let max = Self::max_pipe_edge(variant) as usize;
    if requested.size().iter().any(|&edge| edge > max) {
      return Err(bad("destination pipe rectangle is too large"));
    }
    let halo = if variant == Variant::Xtrans {
      80i64
    } else {
      112i64
    };
    let row = i64::from(requested.top) - halo;
    let column = i64::from(requested.left) - halo;
    let (row, column) = match variant {
      Variant::Bayer => (row.div_euclid(2) * 2, (column - 1).div_euclid(2) * 2 + 1),
      Variant::Xtrans => (row.div_euclid(6) * 6, column.div_euclid(6) * 6),
      Variant::LinearRaw | Variant::PanoramaRaw => {
        // The binary subtracts (requested origin & 3) from origin-halo.
        // halo=112 is divisible by four, so this is the same floor alignment.
        (row.div_euclid(4) * 4, column.div_euclid(4) * 4)
      }
      Variant::XtransDetails => return Err(bad("Enhance Details requires its own tile wrapper")),
    };
    let coord = |n: i64| i32::try_from(n).map_err(|_| bad("model coordinates overflow i32"));
    let source = Rect::new(
      coord(row)?,
      coord(column)?,
      coord(row + 1024)?,
      coord(column + 1024)?,
    )?;
    let output = Rect::new(
      coord(row + halo)?,
      coord(column + halo)?,
      coord(row + 1024 - halo)?,
      coord(column + 1024 - halo)?,
    )?;
    if !output.contains(requested) {
      return Err(bad("model output does not contain requested pixels"));
    }
    Ok(Self {
      requested,
      source,
      output,
      valid: output,
    })
  }

  /// Requested destination pixels expressed as a crop in the model output tensor.
  /// No resampling or averaging occurs: this is only a coordinate translation.
  pub fn output_crop(self) -> Result<Rect> {
    if !self.output.contains(self.requested) {
      return Err(bad("requested rectangle lies outside model output"));
    }
    // Containment and the checked output dimensions bound these differences.
    Rect::new(
      self.requested.top - self.output.top,
      self.requested.left - self.output.left,
      self.requested.bottom - self.output.top,
      self.requested.right - self.output.left,
    )
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn matches_native_converter_calculator_captures() {
    let oracle: serde_json::Value = serde_json::from_str(include_str!(
      "../../../tests/fixtures/adobe-denoise-tiles.json"
    ))
    .unwrap();
    let cases = oracle["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 39);
    let rect = |value: &serde_json::Value| -> Rect {
      let array = value.as_array().unwrap();
      assert_eq!(array.len(), 4);
      let coordinates: [i32; 4] =
        std::array::from_fn(|i| i32::try_from(array[i].as_i64().unwrap()).unwrap());
      Rect::new(
        coordinates[0],
        coordinates[1],
        coordinates[2],
        coordinates[3],
      )
      .unwrap()
    };
    for case in cases {
      let variant = match case["variant"].as_str().unwrap() {
        "bayer" => Variant::Bayer,
        "xtrans" => Variant::Xtrans,
        "linear_raw" => Variant::LinearRaw,
        unknown => panic!("unknown captured variant {unknown}"),
      };
      let actual = TileGeometry::calculate(variant, rect(&case["requested"])).unwrap();
      assert_eq!(actual.source, rect(&case["source"]), "{case}");
      assert_eq!(actual.output, rect(&case["output"]), "{case}");
      assert_eq!(actual.valid, rect(&case["valid"]), "{case}");
      // Both dense loaders instantiate this same observed calculator type.
      if variant == Variant::LinearRaw {
        let panorama = TileGeometry::calculate(Variant::PanoramaRaw, actual.requested).unwrap();
        assert_eq!(panorama, actual);
      }
    }
  }

  #[test]
  fn origin_tiles_preserve_negative_halos_and_canonical_phase() {
    let bayer =
      TileGeometry::calculate(Variant::Bayer, Rect::new(0, 0, 799, 799).unwrap()).unwrap();
    assert_eq!(bayer.source.as_array(), [-112, -113, 912, 911]);
    assert_eq!(bayer.output.as_array(), [0, -1, 800, 799]);
    assert_eq!(bayer.output_crop().unwrap().as_array(), [0, 1, 799, 800]);
    let xtrans =
      TileGeometry::calculate(Variant::Xtrans, Rect::new(0, 0, 859, 859).unwrap()).unwrap();
    assert_eq!(xtrans.source.as_array(), [-84, -84, 940, 940]);
    assert_eq!(xtrans.output.as_array(), [-4, -4, 860, 860]);
    assert_eq!(xtrans.output_crop().unwrap().as_array(), [4, 4, 863, 863]);
  }

  #[test]
  fn dense_raw_calculator_reserves_four_pixels_and_aligns_to_four() {
    for variant in [Variant::LinearRaw, Variant::PanoramaRaw] {
      let tile = TileGeometry::calculate(variant, Rect::new(0, 0, 796, 796).unwrap()).unwrap();
      assert_eq!(tile.source.as_array(), [-112, -112, 912, 912]);
      assert_eq!(tile.output.as_array(), [0, 0, 800, 800]);
      assert_eq!(tile.output_crop().unwrap().as_array(), [0, 0, 796, 796]);
      let tile = TileGeometry::calculate(variant, Rect::new(-1, -1, 795, 795).unwrap()).unwrap();
      assert_eq!(tile.source.as_array(), [-116, -116, 908, 908]);
      assert_eq!(tile.output.as_array(), [-4, -4, 796, 796]);
      assert_eq!(tile.output_crop().unwrap().as_array(), [3, 3, 799, 799]);
    }
  }

  #[test]
  fn negative_origins_floor_instead_of_truncating_toward_zero() {
    let bayer = TileGeometry::calculate(Variant::Bayer, Rect::new(-1, -1, 1, 1).unwrap()).unwrap();
    assert_eq!(bayer.source.as_array(), [-114, -113, 910, 911]);
    assert_eq!(bayer.output.as_array(), [-2, -1, 798, 799]);
    let xtrans =
      TileGeometry::calculate(Variant::Xtrans, Rect::new(-1, -1, 1, 1).unwrap()).unwrap();
    assert_eq!(xtrans.source.as_array(), [-84, -84, 940, 940]);
    // At a negative multiple, no extra cell may be subtracted.
    let xtrans =
      TileGeometry::calculate(Variant::Xtrans, Rect::new(-4, -4, -3, -3).unwrap()).unwrap();
    assert_eq!(xtrans.source.as_array(), [-84, -84, 940, 940]);
  }

  #[test]
  fn every_origin_phase_contains_maximum_requested_work() {
    for variant in [
      Variant::Bayer,
      Variant::Xtrans,
      Variant::LinearRaw,
      Variant::PanoramaRaw,
    ] {
      let max = TileGeometry::max_pipe_edge(variant);
      let output_edge = if variant == Variant::Xtrans { 864 } else { 800 };
      for top in -120..120 {
        for left in -120..120 {
          let requested = Rect::new(top, left, top + max, left + max).unwrap();
          let tile = TileGeometry::calculate(variant, requested).unwrap();
          assert_eq!(tile.source.size(), [1024, 1024]);
          assert_eq!(tile.output.size(), [output_edge, output_edge]);
          assert_eq!(tile.valid, tile.output);
          assert!(tile.output.contains(requested));
          assert_eq!(tile.output_crop().unwrap().size(), requested.size());
          if variant == Variant::Bayer {
            assert_eq!(tile.source.top().rem_euclid(2), 0);
            assert_eq!(tile.source.left().rem_euclid(2), 1);
          } else {
            let period = if variant == Variant::Xtrans { 6 } else { 4 };
            assert_eq!(tile.source.top().rem_euclid(period), 0);
            assert_eq!(tile.source.left().rem_euclid(period), 0);
          }
        }
      }
    }
  }

  #[test]
  fn small_edge_work_retains_full_model_tiles() {
    for variant in [
      Variant::Bayer,
      Variant::Xtrans,
      Variant::LinearRaw,
      Variant::PanoramaRaw,
    ] {
      let tile =
        TileGeometry::calculate(variant, Rect::new(3000, 4000, 3001, 4002).unwrap()).unwrap();
      assert_eq!(tile.source.size(), [1024, 1024]);
      assert_eq!(tile.output_crop().unwrap().size(), [1, 2]);
      assert!(tile.output.contains(tile.requested));
    }
  }

  #[test]
  fn rejects_unrepresentable_rectangles_and_oversized_work() {
    assert!(Rect::new(0, 0, 0, 1).is_err());
    assert!(Rect::new(2, 0, 1, 1).is_err());
    assert!(Rect::new(i32::MIN, 0, i32::MAX, 1).is_err());
    for variant in [
      Variant::Bayer,
      Variant::Xtrans,
      Variant::LinearRaw,
      Variant::PanoramaRaw,
    ] {
      let max = TileGeometry::max_pipe_edge(variant);
      assert!(TileGeometry::calculate(variant, Rect::new(0, 0, max + 1, 1).unwrap()).is_err());
      assert!(TileGeometry::calculate(variant, Rect::new(0, 0, 1, max + 1).unwrap()).is_err());
      let low = Rect::new(i32::MIN, i32::MIN, i32::MIN + 1, i32::MIN + 1).unwrap();
      let high = Rect::new(i32::MAX - 1, i32::MAX - 1, i32::MAX, i32::MAX).unwrap();
      assert!(TileGeometry::calculate(variant, low).is_err());
      assert!(TileGeometry::calculate(variant, high).is_err());
    }
  }
}
