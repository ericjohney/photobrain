//! Observed image preparation and destination traversal, separate from inference.
//!
//! Converter 18.7 arm64 `MakeMirroredImage` (0x100a524a4) reverses complete
//! phase-sized strips without reversing pixels within a strip. Its phase=1
//! branch reflects individual pixels. Runtime source captures independently
//! confirm every top-halo Bayer sample and top/left/corner X-Trans sample.
//! The opposite edges follow the statically observed reverse-strip loops.
//!
//! `Run` (0x100e34d28) enumerates destination rectangles using the point-based
//! `dng_tile_iterator` constructor (0x10135d334) and GetOneTile (0x10135d448).
//! Native iterator captures validate the ordered rectangles, including clipping
//! and shifted origins. Actual concurrent execution/completion order can differ.
//!
//! `cr_stage_get_image::Process_32` (0x100b2b39c) passes repeat sizes (1,1)
//! to `Get32` (0x100b2aef8). With edge option 2 this repeats the nearest pixel
//! outside the allocated image; it does not continue CFA-block reflection.
//! Synthetic native Get32 captures verify every edge/corner, shifted bounds,
//! wholly out-of-bounds requests, and one/three-plane float images.
//! The actual model preprocessing task selects edge option 2 at 0x100e36924.

use super::{
  Variant,
  tiles::{Rect, TileGeometry},
};
use crate::{Error, Result};

fn bad(message: &str) -> Error {
  Error::Malformed(format!("denoise border: {message}"))
}

/// The edge-option-2 / repeat-size-(1,1) mapping used by GetImage's CPU stage.
/// Bounds are nonempty by construction. Repetition is independent per axis.
pub fn repeat_edge_coordinate(bounds: Rect, row: i32, column: i32) -> [i32; 2] {
  [
    row.clamp(bounds.top(), bounds.bottom() - 1),
    column.clamp(bounds.left(), bounds.right() - 1),
  ]
}

/// A single, bounded reflection of phase-sized blocks around the source image.
/// This models the explicitly allocated mirrored image, not later GetImage
/// edge-repeat outside that image. Padding larger than the original image is
/// rejected: recursive reflection for tiny images has not been established.
#[derive(Clone, Copy, Debug)]
pub struct PhaseMirror {
  bounds: Rect,
  padded: Rect,
  period: i64,
}

impl PhaseMirror {
  /// `padding` is rounded upward to a multiple of `period`, as in the native
  /// routine. Period 2 preserves Bayer blocks; period 6 preserves X-Trans blocks.
  /// Period 1 is ordinary reflection including the nearest edge pixel.
  pub fn new(bounds: Rect, padding: u32, period: u32) -> Result<Self> {
    if !matches!(period, 1 | 2 | 6) {
      return Err(bad("supported reflection periods are 1, 2 and 6"));
    }
    let period = i64::from(period);
    let padding = (i64::from(padding) + period - 1) / period * period;
    if bounds.size().iter().any(|&size| (size as i64) < padding) {
      return Err(bad("padding exceeds source dimensions"));
    }
    let convert = |value: i64| i32::try_from(value).map_err(|_| bad("padded coordinate overflow"));
    let padded = Rect::new(
      convert(i64::from(bounds.top()) - padding)?,
      convert(i64::from(bounds.left()) - padding)?,
      convert(i64::from(bounds.bottom()) + padding)?,
      convert(i64::from(bounds.right()) + padding)?,
    )?;
    Ok(Self {
      bounds,
      padded,
      period,
    })
  }

  pub fn bounds(self) -> Rect {
    self.bounds
  }
  pub fn padded_bounds(self) -> Rect {
    self.padded
  }

  /// Compose GetImage's edge repetition with the explicitly allocated mirror.
  /// Model requests beyond that allocation (including the Bayer leftmost
  /// column and trailing partial tiles) repeat the padded edge pixel.
  pub fn source_coordinate_with_edge_repeat(self, row: i32, column: i32) -> [i32; 2] {
    let [row, column] = repeat_edge_coordinate(self.padded, row, column);
    self
      .source_coordinate(row, column)
      .expect("edge repetition maps inside the padded rectangle")
  }

  /// Source position for a pixel in the explicitly padded image. No arithmetic
  /// touches sample values, so copies preserve all f32 bit patterns.
  pub fn source_coordinate(self, row: i32, column: i32) -> Result<[i32; 2]> {
    if row < self.padded.top()
      || row >= self.padded.bottom()
      || column < self.padded.left()
      || column >= self.padded.right()
    {
      return Err(bad("coordinate lies outside the allocated mirrored image"));
    }
    let axis = |position: i32, start: i32, end: i32| {
      let p = i64::from(position);
      let lo = i64::from(start);
      let hi = i64::from(end);
      let source = if p < lo {
        let local = p - lo;
        lo + (-local.div_euclid(self.period) - 1) * self.period + local.rem_euclid(self.period)
      } else if p >= hi {
        let local = p - hi;
        hi - (local / self.period + 1) * self.period + local % self.period
      } else {
        p
      };
      // Bounds and padding validation ensure the mapped coordinate is inside.
      source as i32
    };
    Ok([
      axis(row, self.bounds.top(), self.bounds.bottom()),
      axis(column, self.bounds.left(), self.bounds.right()),
    ])
  }
}

/// Destination tile enumeration order, anchored at the destination's own origin.
/// This is not a promise of serialized execution or completion order.
#[derive(Clone, Debug)]
pub struct TileTraversal {
  bounds: Rect,
  edge: i64,
  row: i64,
  column: i64,
}

impl TileTraversal {
  pub fn new(variant: Variant, bounds: Rect) -> Self {
    Self {
      bounds,
      edge: i64::from(TileGeometry::max_pipe_edge(variant)),
      row: i64::from(bounds.top()),
      column: i64::from(bounds.left()),
    }
  }
}

impl Iterator for TileTraversal {
  type Item = Rect;

  fn next(&mut self) -> Option<Rect> {
    if self.row >= i64::from(self.bounds.bottom()) {
      return None;
    }
    let bottom = (self.row + self.edge).min(i64::from(self.bounds.bottom()));
    let right = (self.column + self.edge).min(i64::from(self.bounds.right()));
    let result = Rect::new(
      self.row as i32,
      self.column as i32,
      bottom as i32,
      right as i32,
    )
    .expect("clipped subrectangle of valid bounds");
    self.column = right;
    if right == i64::from(self.bounds.right()) {
      self.column = i64::from(self.bounds.left());
      self.row = bottom;
    }
    Some(result)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn edge_repeat_matches_native_get32_capture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
      "../../../tests/fixtures/adobe-denoise-edge-repeat.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
      let rect = |key: &str| {
        let c = case[key].as_array().unwrap();
        Rect::new(
          c[0].as_i64().unwrap() as i32,
          c[1].as_i64().unwrap() as i32,
          c[2].as_i64().unwrap() as i32,
          c[3].as_i64().unwrap() as i32,
        )
        .unwrap()
      };
      let bounds = rect("bounds");
      let requested = rect("requested");
      let planes = case["planes"].as_u64().unwrap() as usize;
      let mut actual = Vec::new();
      for row in requested.top()..requested.bottom() {
        for column in requested.left()..requested.right() {
          let [r, c] = repeat_edge_coordinate(bounds, row, column);
          for channel in 0..planes {
            let index = ((r - bounds.top()) as usize * bounds.size()[1]
              + (c - bounds.left()) as usize)
              * planes
              + channel;
            actual.push(0x3f000000u32 + index as u32 * 128);
          }
        }
      }
      assert_eq!(serde_json::to_value(actual).unwrap(), case["output_bits"]);
    }
    let mirror = PhaseMirror::new(Rect::new(0, 0, 2000, 3000).unwrap(), 112, 2).unwrap();
    assert_eq!(mirror.source_coordinate_with_edge_repeat(0, -113), [0, 110]);
    assert_eq!(
      mirror.source_coordinate_with_edge_repeat(-1000, -1000),
      [110, 110]
    );
    assert_eq!(
      mirror.source_coordinate_with_edge_repeat(3000, 4000),
      [1889, 2889]
    );
  }

  #[test]
  fn traversal_matches_native_iterator_capture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
      "../../../tests/fixtures/adobe-denoise-traversal.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
      let variant = match case["variant"].as_str().unwrap() {
        "bayer" => Variant::Bayer,
        "xtrans" => Variant::Xtrans,
        "linear_raw" => Variant::LinearRaw,
        _ => unreachable!(),
      };
      let coords: Vec<i32> = case["bounds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_i64().unwrap() as i32)
        .collect();
      let bounds = Rect::new(coords[0], coords[1], coords[2], coords[3]).unwrap();
      let actual: Vec<[i32; 4]> = TileTraversal::new(variant, bounds)
        .map(Rect::as_array)
        .collect();
      assert_eq!(serde_json::to_value(actual).unwrap(), case["tiles"]);
    }
  }

  #[test]
  fn phase_blocks_keep_their_internal_order() {
    for period in [1, 2, 6] {
      let mirror = PhaseMirror::new(Rect::new(13, -17, 61, 31).unwrap(), 12, period).unwrap();
      for distance in 0..12i32 {
        let block = distance / period as i32;
        let offset = distance % period as i32;
        assert_eq!(
          mirror.source_coordinate(13 - 12 + distance, -17).unwrap()[0],
          13 + (12 / period as i32 - block - 1) * period as i32 + offset
        );
        assert_eq!(
          mirror
            .source_coordinate(61 + distance, 31 + distance)
            .unwrap(),
          [
            61 - (block + 1) * period as i32 + offset,
            31 - (block + 1) * period as i32 + offset
          ]
        );
      }
    }
    let x = PhaseMirror::new(Rect::new(0, 0, 200, 200).unwrap(), 80, 6).unwrap();
    assert_eq!(x.padded_bounds().as_array(), [-84, -84, 284, 284]);
    assert!(x.source_coordinate(-85, 0).is_err());
    assert!(PhaseMirror::new(Rect::new(0, 0, 3, 3).unwrap(), 4, 2).is_err());
    assert!(PhaseMirror::new(Rect::new(0, 0, 3, 3).unwrap(), 1, 0).is_err());
    assert!(PhaseMirror::new(Rect::new(i32::MIN, 0, i32::MIN + 100, 100).unwrap(), 2, 2).is_err());
  }

  #[test]
  fn captured_source_halos_are_bit_exact() {
    use super::super::Tensor;
    let Some(root) = std::env::var_os("RAW_DENOISE_CAPTURE_FIXTURES") else {
      eprintln!("skipped source border capture: set RAW_DENOISE_CAPTURE_FIXTURES");
      return;
    };
    for (name, period, offset, left, expected_count) in [
      ("bayer", 2, 112, 687, 114688),
      ("xtrans", 6, 84, -84, 164976),
    ] {
      let path = std::path::Path::new(&root).join(format!("{name}-output/preprocess-source.f32"));
      let source = Tensor::read(path).unwrap();
      assert_eq!(source.shape(), [1, 1024, 1024]);
      // Only top/left boundaries occur in these captures; distant bottom/right
      // values are irrelevant to this comparison and are not asserted here.
      let mirror =
        PhaseMirror::new(Rect::new(0, 0, 3000, 3000).unwrap(), offset as u32, period).unwrap();
      let mut checked = 0;
      for row in -offset..1024 - offset {
        for column in left..left + 1024 {
          if row >= 0 && column >= 0 {
            continue;
          }
          let [r, c] = mirror.source_coordinate(row, column).unwrap();
          let index = ((row + offset) * 1024 + column - left) as usize;
          let mapped = ((r + offset) * 1024 + c - left) as usize;
          assert_eq!(
            source.data()[index].to_bits(),
            source.data()[mapped].to_bits(),
            "{name} border at ({row},{column})"
          );
          checked += 1;
        }
      }
      assert_eq!(checked, expected_count);
      eprintln!("{name}: {checked} captured border samples bit-exact");
    }
  }
}
